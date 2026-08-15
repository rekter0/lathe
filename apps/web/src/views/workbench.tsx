import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import * as Tabs from "@radix-ui/react-tabs";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { Activity, Archive, ArrowLeft, Check, ChevronDown, CircleStop, Code2, Download, Eye, FilePlus2, GitBranch, GitCompare, Paperclip, Play, RotateCcw, Save, SlidersHorizontal, Split, Wrench } from "lucide-react";
import { pathToRoot, type JsonObject, type JsonValue, type MessagePart, type ResolvedConfig } from "@lathe/domain";
import { api, consumeEvents, downloadApiFile, jsonBody } from "../api.js";
import { Button, Field, Input, Select, Textarea } from "../components/forms.js";
import { isComposerSubmitKey } from "../components/composer-keys.js";
import { McpApprovalResolver } from "../components/mcp-approval.js";
import { useUiStore } from "../store.js";
import type { AssetRevision, Attachment, AutomationJob, BranchRef, Finding, MessageNode, ModelRun, SafeProvider, WorkbenchData } from "../types.js";

export function WorkbenchPage() {
  const { projectId, sessionId } = useParams({ from: "/projects/$projectId/sessions/$sessionId" });
  const queryClient = useQueryClient();
  const workbench = useQuery({
    queryKey: ["workbench", sessionId],
    queryFn: () => api<WorkbenchData>(`/api/sessions/${sessionId}`),
    refetchInterval: (query) => query.state.data?.runs.some((run) => ["queued", "streaming"].includes(run.status)) ? 1_000 : false
  });
  const [branchId, setBranchId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const compareBranchIds = useUiStore((state) => state.compareBranchIds);
  const setCompareBranchIds = useUiStore((state) => state.setCompareBranchIds);

  useEffect(() => {
    if (!branchId && workbench.data) setBranchId(workbench.data.session.activeBranchId ?? workbench.data.branches[0]?.id ?? null);
  }, [branchId, workbench.data]);
  useEffect(() => {
    const controller = new AbortController();
    void consumeEvents(`session:${sessionId}`, controller.signal, () => void queryClient.invalidateQueries({ queryKey: ["workbench", sessionId] })).catch(() => undefined);
    return () => controller.abort();
  }, [queryClient, sessionId]);

  if (workbench.isLoading) return <div className="loading-view"><span className="spinner" /> Loading workbench…</div>;
  if (workbench.error || !workbench.data) return <div className="error-view"><h2>Workbench unavailable</h2><p>{workbench.error?.message}</p></div>;
  const data = workbench.data;
  const branch = data.branches.find((item) => item.id === branchId) ?? data.branches[0];
  if (!branch) return <div className="error-view">Session has no branch.</div>;
  const path = pathToRoot(data.nodes, branch.headNodeId);
  const selectedNode = data.nodes.find((node) => node.id === selectedNodeId) ?? path.at(-1) ?? null;
  const comparisonBranches = compareBranchIds.flatMap((id) => data.branches.find((item) => item.id === id) ?? []);

  return <div className="workbench">
    <div className="workbench-header">
      <div><Link to="/" search={{ project: projectId } as never} className="back-link"><ArrowLeft size={14} /> project</Link><h1>{data.session.name}</h1></div>
      <div className="branch-toolbar">
        <Select value={branch.id} onChange={(event) => { setBranchId(event.target.value); setCompareBranchIds([]); }} aria-label="Active branch">
          {data.branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <ComparisonPicker branches={data.branches} activeBranch={branch} selectedIds={compareBranchIds} onChange={setCompareBranchIds} />
        <BranchActions data={data} branch={branch} selectedNode={selectedNode} onChanged={() => void workbench.refetch()} />
      </div>
    </div>
    <div className="workbench-grid">
      <aside className="tree-pane">
        <div className="pane-label"><GitBranch size={14} /> CONVERSATION TREE <span>{data.nodes.length}</span></div>
        <TreeOverview nodes={data.nodes} branches={data.branches} selectedNodeId={selectedNode?.id ?? null} onSelect={setSelectedNodeId} />
        <div className="branch-legend">{data.branches.map((item) => <button key={item.id} onClick={() => setBranchId(item.id)} className={item.id === branch.id ? "active" : ""}><span />{item.name}</button>)}</div>
      </aside>
      <section className="transcript-pane">
        {comparisonBranches.length > 0 ? <ComparisonView nodes={data.nodes} runs={data.runs} branches={[branch, ...comparisonBranches]} /> : <Transcript nodes={path} runs={data.runs} data={data} onBranchCreated={(id) => { setBranchId(id); void workbench.refetch(); }} onRunStarted={useUiStore.getState().setSelectedRunId} onSelectRun={useUiStore.getState().setSelectedRunId} />}
        {comparisonBranches.length === 0 && <Composer data={data} branch={branch} onRunStarted={useUiStore.getState().setSelectedRunId} onChanged={() => void workbench.refetch()} />}
      </section>
      <aside className="inspector-pane"><Inspector data={data} branch={branch} selectedNode={selectedNode} onChanged={() => void workbench.refetch()} /></aside>
    </div>
  </div>;
}

function TreeOverview({ nodes, branches, selectedNodeId, onSelect }: { nodes: MessageNode[]; branches: BranchRef[]; selectedNodeId: string | null; onSelect(id: string): void }) {
  const layout = useMemo(() => {
    const children = new Map<string | null, MessageNode[]>();
    for (const node of nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
    let leaf = 0;
    const positions = new Map<string, { x: number; y: number }>();
    const place = (node: MessageNode, depth: number): number => {
      const descendants = children.get(node.id) ?? [];
      const x = descendants.length === 0 ? leaf++ * 92 : descendants.map((child) => place(child, depth + 1)).reduce((sum, value) => sum + value, 0) / descendants.length;
      positions.set(node.id, { x, y: depth * 76 });
      return x;
    };
    for (const root of children.get(null) ?? []) place(root, 0);
    const flowNodes: Node[] = nodes.map((node) => ({
      id: node.id,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { label: node.role === "assistant" ? "AI" : node.role === "tool" ? "TOOL" : "YOU" },
      className: `tree-node tree-node-${node.role} ${selectedNodeId === node.id ? "selected" : ""}`,
      style: { width: 64, height: 32 }
    }));
    const flowEdges: Edge[] = nodes.filter((node) => node.parentId).map((node) => ({ id: `${node.parentId}-${node.id}`, source: node.parentId!, target: node.id, className: "tree-edge" }));
    return { flowNodes, flowEdges };
  }, [nodes, selectedNodeId]);
  return <ReactFlow nodes={layout.flowNodes} edges={layout.flowEdges} fitView minZoom={0.15} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, node) => onSelect(node.id)}>
    <Background color="#24312d" gap={18} size={1} /><Controls showInteractive={false} position="bottom-left" />
  </ReactFlow>;
}

function Transcript({ nodes, runs, data, onBranchCreated, onRunStarted, onSelectRun }: { nodes: MessageNode[]; runs: ModelRun[]; data?: WorkbenchData; onBranchCreated?(id: string): void; onRunStarted?(id: string): void; onSelectRun(id: string): void }) {
  return <div className="transcript-scroll">
    {nodes.length === 0 && <div className="transcript-empty"><Split size={28} /><h2>The branch starts here</h2><p>Send a payload below. Every response becomes a forkable node.</p></div>}
    {nodes.map((node) => {
      const run = node.sourceRunId ? runs.find((item) => item.id === node.sourceRunId) : undefined;
      return <TranscriptMessage key={node.id} node={node} {...(run ? { run } : {})} {...(data ? { data } : {})} {...(onBranchCreated ? { onBranchCreated } : {})} {...(onRunStarted ? { onRunStarted } : {})} onSelectRun={onSelectRun} />;
    })}
  </div>;
}

export function TranscriptMessage({ node, run, data, onBranchCreated, onRunStarted, onSelectRun }: { node: MessageNode; run?: ModelRun; data?: WorkbenchData; onBranchCreated?(id: string): void; onRunStarted?(id: string): void; onSelectRun(id: string): void }) {
  const [raw, setRaw] = useState(false);
  const reasoning = reasoningFromRun(run);
  const toggleLabel = raw ? "Show rendered message" : "Show raw message text";
  return <article className={`message message-${node.role}`}>
    <header>
      <span>{node.role === "assistant" ? "MODEL" : node.role === "tool" ? "TOOL RESULT" : "OPERATOR"}</span>
      <time>{new Date(node.createdAt).toLocaleTimeString()}</time>
      {run && <button onClick={() => onSelectRun(run.id)}>inspect run</button>}
      <button className="message-view-toggle" type="button" aria-label={toggleLabel} aria-pressed={raw} onClick={() => setRaw((current) => !current)}>{raw ? <Eye size={10} /> : <Code2 size={10} />}{raw ? "rendered" : "raw"}</button>
      {node.role === "user" && data && <ResendAction node={node} data={data} {...(onBranchCreated ? { onBranchCreated } : {})} {...(onRunStarted ? { onRunStarted } : {})} />}
    </header>
    <div className={`message-body${raw ? " is-raw" : ""}`}>
      {reasoning && <details className="message-reasoning" open><summary><Activity size={12} /> Reasoning <span>{reasoning.length} chars</span></summary><div>{raw ? <RawText text={reasoning} /> : <RenderedText text={reasoning} />}</div></details>}
      {node.parts.map((part, index) => <MessagePartView key={`${node.id}-${index}`} part={part} raw={raw} />)}
    </div>
    <footer><code>{node.id.slice(0, 8)}</code>{node.configSnapshotId && <span>config {node.configSnapshotId.slice(0, 8)}</span>}</footer>
  </article>;
}

function reasoningFromRun(run?: ModelRun): string | null {
  if (!run?.normalizedOutput || typeof run.normalizedOutput !== "object" || Array.isArray(run.normalizedOutput)) return null;
  const reasoning = run.normalizedOutput.reasoning;
  return typeof reasoning === "string" && reasoning.length > 0 ? reasoning : null;
}

function ResendAction({ node, data, onBranchCreated, onRunStarted }: { node: MessageNode; data: WorkbenchData; onBranchCreated?(id: string): void; onRunStarted?(id: string): void }) {
  const resend = useMutation({
    mutationFn: async () => {
      if (!data.session.providerProfileId || !data.session.modelId) throw new Error("Select a provider and model before resending");
      const originalText = node.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const text = window.prompt("Edit payload before resending", originalText);
      if (text === null || !text.trim()) return null;
      const branchName = window.prompt("New branch name", `edit-${node.id.slice(0, 6)}`);
      if (!branchName) return null;
      const created = await api<{ branch: BranchRef }>("/api/branches", { method: "POST", ...jsonBody({ sessionId: data.session.id, name: branchName, headNodeId: node.parentId }) });
      const parts: MessagePart[] = [{ type: "text", text }, ...node.parts.filter((part) => part.type !== "text")];
      const appended = await api<{ node: MessageNode }>(`/api/sessions/${data.session.id}/messages`, { method: "POST", ...jsonBody({ branchId: created.branch.id, parentId: node.parentId, role: "user", parts }) });
      const started = await api<{ run: { id: string } }>("/api/runs", { method: "POST", ...jsonBody({ sessionId: data.session.id, branchId: created.branch.id, contextNodeId: appended.node.id }) });
      return { branchId: created.branch.id, runId: started.run.id };
    },
    onSuccess: (result) => { if (result) { onRunStarted?.(result.runId); onBranchCreated?.(result.branchId); } }
  });
  return <button className="message-resend" onClick={() => resend.mutate()} disabled={resend.isPending} title={resend.error?.message ?? "Edit this operator turn and resend it on a new sibling branch"}><RotateCcw size={10} />{resend.isPending ? "branching…" : "edit / resend"}</button>;
}

function RenderedText({ text }: { text: string }) {
  return <ReactMarkdown skipHtml rehypePlugins={[rehypeSanitize]}>{text}</ReactMarkdown>;
}

function RawText({ text }: { text: string }) {
  return <pre className="message-raw">{text}</pre>;
}

function MessagePartView({ part, raw }: { part: MessagePart; raw: boolean }) {
  if (raw) return <RawText text={part.type === "text" ? part.text : JSON.stringify(part, null, 2)} />;
  if (part.type === "text") return <RenderedText text={part.text} />;
  if (part.type === "attachment") return <div className="attachment-chip"><Paperclip size={13} />{part.name}<small>{part.mediaType}</small></div>;
  if (part.type === "tool-call") return <div className="tool-call"><Wrench size={14} /><strong>{part.name}</strong><code>{JSON.stringify(part.arguments, null, 2)}</code></div>;
  return <div className={`tool-result ${part.isError ? "is-error" : ""}`}><Check size={14} /><strong>{part.name}</strong><code>{JSON.stringify(part.result, null, 2)}</code></div>;
}

function ComparisonPicker({ branches, activeBranch, selectedIds, onChange }: { branches: BranchRef[]; activeBranch: BranchRef; selectedIds: string[]; onChange(ids: string[]): void }) {
  const candidates = branches.filter((item) => item.id !== activeBranch.id);
  return <details className="comparison-picker"><summary><GitCompare size={13} />{selectedIds.length === 0 ? "Compare branches" : `${selectedIds.length + 1} branches`}</summary><div className="comparison-menu"><small>Select up to three branches alongside {activeBranch.name}.</small>{candidates.map((candidate) => {
    const checked = selectedIds.includes(candidate.id);
    return <label key={candidate.id}><input type="checkbox" checked={checked} disabled={!checked && selectedIds.length >= 3} onChange={(event) => onChange(event.target.checked ? [...selectedIds, candidate.id] : selectedIds.filter((id) => id !== candidate.id))} />{candidate.name}</label>;
  })}{candidates.length === 0 && <small>No other branches yet.</small>}</div></details>;
}

function ComparisonView({ nodes, runs, branches }: { nodes: MessageNode[]; runs: ModelRun[]; branches: BranchRef[] }) {
  const paths = branches.map((branch) => pathToRoot(nodes, branch.headNodeId));
  let sharedLength = 0;
  while (paths.every((path) => path[sharedLength]?.id === paths[0]?.[sharedLength]?.id) && paths[0]?.[sharedLength]) sharedLength += 1;
  const ancestor = paths[0]?.[sharedLength - 1] ?? null;
  return <div className="comparison-view">
    <div className="comparison-summary"><GitCompare size={16} /> Common ancestor: {ancestor?.id.slice(0, 8) ?? "none"} · {sharedLength} shared nodes · {branches.length} paths</div>
    <div className="comparison-columns" style={{ gridTemplateColumns: `repeat(${branches.length}, minmax(0, 1fr))` }}>{branches.map((branch, index) => <section key={branch.id}><h3>{branch.name}</h3><Transcript nodes={paths[index]?.slice(sharedLength) ?? []} runs={runs} onSelectRun={() => undefined} /></section>)}</div>
  </div>;
}

function BranchActions({ data, branch, selectedNode, onChanged }: { data: WorkbenchData; branch: BranchRef; selectedNode: MessageNode | null; onChanged(): void }) {
  const fork = useMutation({ mutationFn: async () => {
    const name = window.prompt("Branch name", `variation-${data.branches.length}`);
    if (!name) return;
    await api("/api/branches", { method: "POST", ...jsonBody({ sessionId: data.session.id, name, headNodeId: selectedNode?.id ?? branch.headNodeId }) });
  }, onSuccess: onChanged });
  const rewind = useMutation({ mutationFn: () => api(`/api/branches/${branch.id}/head`, { method: "PATCH", ...jsonBody({ headNodeId: selectedNode?.id ?? null }) }), onSuccess: onChanged });
  const checkpoint = useMutation({ mutationFn: async () => {
    const name = window.prompt("Checkpoint name", "checkpoint");
    if (!name) return;
    await api(`/api/sessions/${data.session.id}/checkpoints`, { method: "POST", ...jsonBody({ name, nodeId: selectedNode?.id ?? branch.headNodeId }) });
  }, onSuccess: onChanged });
  return <><Button variant="ghost" onClick={() => fork.mutate()} title="Fork selected node"><GitBranch size={15} /></Button><Button variant="ghost" onClick={() => rewind.mutate()} title="Move branch head to selected node"><RotateCcw size={15} /></Button><Button variant="ghost" onClick={() => checkpoint.mutate()} title="Checkpoint selected node"><Archive size={15} /></Button></>;
}

function Composer({ data, branch, onRunStarted, onChanged }: { data: WorkbenchData; branch: BranchRef; onRunStarted(id: string): void; onChanged(): void }) {
  const [message, setMessage] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const send = useMutation({
    mutationFn: async () => {
      let contextNodeId = branch.headNodeId;
      if (attachmentIds.length > 0) {
        const parts: MessagePart[] = [{ type: "text", text: message }, ...attachmentIds.flatMap((id) => {
          const item = data.attachments.find((attachment) => attachment.id === id);
          return item ? [{ type: "attachment" as const, attachmentId: item.id, name: item.fileName, mediaType: item.mediaType }] : [];
        })];
        const response = await api<{ node: MessageNode }>(`/api/sessions/${data.session.id}/messages`, { method: "POST", ...jsonBody({ branchId: branch.id, parentId: branch.headNodeId, role: "user", parts }) });
        contextNodeId = response.node.id;
      }
      return api<{ run: { id: string } }>("/api/runs", { method: "POST", ...jsonBody({ sessionId: data.session.id, branchId: branch.id, contextNodeId, ...(attachmentIds.length === 0 ? { userMessage: message } : {}) }) });
    },
    onSuccess: ({ run }) => { setMessage(""); setAttachmentIds([]); onRunStarted(run.id); onChanged(); }
  });
  const upload = useMutation({ mutationFn: async (file: File) => {
    const form = new FormData(); form.set("file", file);
    return api<{ attachment: Attachment }>(`/api/projects/${data.session.projectId}/attachments`, { method: "POST", body: form });
  }, onSuccess: ({ attachment }) => { setAttachmentIds((ids) => [...ids, attachment.id]); onChanged(); } });
  const canSend = message.trim().length > 0 && !send.isPending && Boolean(data.session.providerProfileId);
  return <div className="composer">
    {data.attachments.length > 0 && <div className="attachment-picker">{data.attachments.map((attachment) => <label key={attachment.id}><input type="checkbox" checked={attachmentIds.includes(attachment.id)} onChange={(event) => setAttachmentIds((ids) => event.target.checked ? [...ids, attachment.id] : ids.filter((id) => id !== attachment.id))} />{attachment.fileName}</label>)}</div>}
    <form onSubmit={(event) => { event.preventDefault(); if (canSend) send.mutate(); }}>
      <label className="attach-button"><Paperclip size={17} /><input type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload.mutate(file); }} /></label>
      <Textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
        if (!isComposerSubmitKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) return;
        event.preventDefault();
        if (canSend) event.currentTarget.form?.requestSubmit();
      }} placeholder="Enter the next operator payload…" rows={2} required aria-keyshortcuts="Enter Shift+Enter" />
      <Button disabled={!canSend}>{send.isPending ? <span className="spinner small" /> : <Play size={16} />} Run</Button>
    </form>
    <small className="composer-shortcut">Enter to run · Shift+Enter for a new line</small>
    {!data.session.providerProfileId && <small className="composer-hint">Select a provider and model in the inspector before running.</small>}
    {send.error && <div className="form-error">{send.error.message}</div>}
  </div>;
}

interface RunEventEnvelope {
  id: number;
  channel: string;
  type: string;
  timestamp: string;
  data: JsonValue;
}

const runRefreshEvents = new Set(["run.awaiting-tool", "run.completed", "run.failed", "run.cancelled", "run.interrupted", "provider.error", "tool.continuation.failed", "tool.continuation.limit"]);

function isRunEventEnvelope(value: unknown): value is RunEventEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<RunEventEnvelope>;
  return typeof event.id === "number" && typeof event.channel === "string" && typeof event.type === "string" && typeof event.timestamp === "string" && "data" in event;
}

function Inspector({ data, branch, selectedNode, onChanged }: { data: WorkbenchData; branch: BranchRef; selectedNode: MessageNode | null; onChanged(): void }) {
  const queryClient = useQueryClient();
  const selectedRunId = useUiStore((state) => state.selectedRunId);
  const tab = useUiStore((state) => state.inspectorTab);
  const setTab = useUiStore((state) => state.setInspectorTab);
  const run = data.runs.find((item) => item.id === selectedRunId) ?? data.runs.find((item) => ["queued", "streaming"].includes(item.status)) ?? data.runs[0] ?? null;
  const [runEvents, setRunEvents] = useState<RunEventEnvelope[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  useEffect(() => {
    setRunEvents([]);
    setStreamError(null);
    const runId = run?.id;
    if (!runId) return;
    const controller = new AbortController();
    void consumeEvents(`run:${runId}`, controller.signal, (value) => {
      if (!isRunEventEnvelope(value)) return;
      setRunEvents((prior) => [...prior, value].slice(-500));
      if (runRefreshEvents.has(value.type) || value.type.startsWith("mcp.approval.")) {
        void queryClient.invalidateQueries({ queryKey: ["workbench", data.session.id] });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setStreamError(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [data.session.id, queryClient, run?.id]);
  return <Tabs.Root value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="inspector-tabs">
    <Tabs.List className="inspector-tab-list"><Tabs.Trigger value="config"><SlidersHorizontal size={14} /> Config</Tabs.Trigger><Tabs.Trigger value="run"><Play size={14} /> Run</Tabs.Trigger><Tabs.Trigger value="evidence"><Archive size={14} /> Evidence</Tabs.Trigger></Tabs.List>
    <Tabs.Content value="config"><ConfigInspector data={data} onChanged={onChanged} /></Tabs.Content>
    <Tabs.Content value="run"><RunInspector run={run} events={runEvents} streamError={streamError} onChanged={onChanged} /></Tabs.Content>
    <Tabs.Content value="evidence"><EvidenceInspector data={data} branch={branch} selectedNode={selectedNode} onChanged={onChanged} /></Tabs.Content>
  </Tabs.Root>;
}

function ConfigInspector({ data, onChanged }: { data: WorkbenchData; onChanged(): void }) {
  const [draft, setDraft] = useState<ResolvedConfig>(() => structuredClone(data.session.draftConfig));
  const [selection, setSelection] = useState(data.session.providerProfileId && data.session.modelId ? `${data.session.providerProfileId}::${data.session.modelId}` : "");
  const [overrides, setOverrides] = useState(() => JSON.stringify(draft.protocolOverrides, null, 2));
  const [autoContinueTools, setAutoContinueTools] = useState(data.session.autoContinueTools);
  const [autoContinueLimit, setAutoContinueLimit] = useState(data.session.autoContinueLimit);
  const [promptRevisionId, setPromptRevisionId] = useState("");
  const [toolRevisionId, setToolRevisionId] = useState("");
  const compiledPrompt = useMemo(() => draft.promptBlocks.filter((block) => block.enabled).toSorted((left, right) => left.order - right.order).map((block) => block.content).join("\n\n"), [draft.promptBlocks]);
  const providers = useQuery({ queryKey: ["providers", "with-current-revision"], queryFn: () => api<{ providers: SafeProvider[] }>("/api/providers?includeArchived=true") });
  const prompts = useQuery({ queryKey: ["assets", "prompt"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=prompt") });
  const toolSpecs = useQuery({ queryKey: ["assets", "tool-spec"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=tool-spec") });
  const implementations = useQuery({ queryKey: ["assets", "tool-implementation"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=tool-implementation") });
  const targets = useQuery({ queryKey: ["assets", "target"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=target") });
  const mcpServers = useQuery({ queryKey: ["assets", "mcp-server"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=mcp-server") });
  useEffect(() => {
    const nextDraft = structuredClone(data.session.draftConfig);
    setDraft(nextDraft);
    setOverrides(JSON.stringify(nextDraft.protocolOverrides, null, 2));
  }, [data.session.id, data.session.draftConfig]);
  useEffect(() => {
    setSelection(data.session.providerProfileId && data.session.modelId
      ? `${data.session.providerProfileId}::${data.session.modelId}`
      : "");
  }, [data.session.id, data.session.modelId, data.session.providerProfileId]);
  useEffect(() => { setAutoContinueTools(data.session.autoContinueTools); setAutoContinueLimit(data.session.autoContinueLimit); }, [data.session.autoContinueLimit, data.session.autoContinueTools]);
  const save = useMutation({ mutationFn: async () => {
    const [providerProfileId, modelId] = selection.split("::");
    await api(`/api/sessions/${data.session.id}/model`, { method: "PATCH", ...jsonBody({ providerProfileId: providerProfileId || null, modelId: modelId || null }) });
    await api(`/api/sessions/${data.session.id}/config`, { method: "PATCH", ...jsonBody({ config: { ...draft, protocolOverrides: JSON.parse(overrides) } }) });
    await api(`/api/sessions/${data.session.id}/continuation`, { method: "PATCH", ...jsonBody({ enabled: autoContinueTools, limit: autoContinueLimit }) });
  }, onSuccess: onChanged });
  const saveHarness = useMutation({ mutationFn: async () => {
    if (save.isPending) throw new Error("Save the session draft first");
    const name = window.prompt("New harness name", `${data.session.name} harness`);
    if (!name) return;
    await api(`/api/sessions/${data.session.id}/save-harness`, { method: "POST", ...jsonBody({ name, description: `Saved from ${data.session.name}`, tags: [] }) });
  } });
  const addPrompt = () => {
    const asset = prompts.data?.assets.find((item) => item.id === promptRevisionId);
    if (!asset || !asset.value || typeof asset.value !== "object" || Array.isArray(asset.value) || typeof asset.value.content !== "string") return;
    setDraft({ ...draft, promptBlocks: [...draft.promptBlocks, { revisionId: asset.id, name: asset.name, content: asset.value.content, enabled: true, order: draft.promptBlocks.length }] });
    setPromptRevisionId("");
  };
  const addTool = () => {
    const asset = toolSpecs.data?.assets.find((item) => item.id === toolRevisionId);
    if (!asset || !asset.value || typeof asset.value !== "object" || Array.isArray(asset.value)) return;
    const value = asset.value;
    if (typeof value.name !== "string" || typeof value.description !== "string" || !value.inputSchema || typeof value.inputSchema !== "object" || Array.isArray(value.inputSchema)) return;
    setDraft({ ...draft, tools: [...draft.tools, { toolRevisionId: asset.id, implementationRevisionId: null, name: value.name, description: value.description, inputSchema: value.inputSchema, enabled: true, mode: "manual", targetId: null, mcpServerId: null }] });
    setToolRevisionId("");
  };
  const selectableProviders = providers.data?.providers.filter((provider) => !provider.archivedAt || provider.id === data.session.providerProfileId) ?? [];
  return <div className="inspector-content">
    <Field label="Provider / model"><Select value={selection} onChange={(event) => setSelection(event.target.value)}><option value="">Not selected</option>{selectableProviders.flatMap((provider) => provider.models.map((model) => <option key={`${provider.id}:${model.id}`} value={`${provider.id}::${model.id}`}>{provider.label} · {model.label}{provider.archivedAt ? ` · revision ${provider.revision} (historical)` : ""}</option>))}</Select></Field>
    <div className="two-fields compact"><Field label="Temperature"><Input type="number" min="0" max="2" step="0.1" value={draft.temperature ?? ""} onChange={(event) => setDraft({ ...draft, temperature: event.target.value === "" ? null : Number(event.target.value) })} /></Field>
      <Field label="Max output"><Input type="number" min="1" value={draft.maxOutputTokens ?? ""} onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value === "" ? null : Number(event.target.value) })} /></Field></div>
    <div className="continuation-control"><label className="continuation-toggle"><input type="checkbox" checked={autoContinueTools} onChange={(event) => setAutoContinueTools(event.target.checked)} /><span><strong>Automatic tool continuation</strong><small>Continue after approved tool results until the model stops.</small></span></label><Field label="Turn limit" hint="Hard limit: 32"><Input type="number" min="1" max="32" value={autoContinueLimit} onChange={(event) => setAutoContinueLimit(Math.max(1, Math.min(32, Number(event.target.value) || 1)))} disabled={!autoContinueTools} /></Field></div>
    <div className="config-section"><h3>System prompt blocks <span>{draft.promptBlocks.filter((item) => item.enabled).length}/{draft.promptBlocks.length}</span></h3><div className="inline-add"><Select value={promptRevisionId} onChange={(event) => setPromptRevisionId(event.target.value)}><option value="">Add from library…</option>{prompts.data?.assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select><Button variant="secondary" onClick={addPrompt} disabled={!promptRevisionId}><PlusIcon /></Button></div>{draft.promptBlocks.map((block, index) => <div className="prompt-block" key={`${block.revisionId}-${index}`}><label><input type="checkbox" checked={block.enabled} onChange={(event) => setDraft({ ...draft, promptBlocks: draft.promptBlocks.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item) })} />{block.name}<span className="reorder"><button onClick={() => setDraft({ ...draft, promptBlocks: moveItem(draft.promptBlocks, index, index - 1) })} disabled={index === 0}>↑</button><button onClick={() => setDraft({ ...draft, promptBlocks: moveItem(draft.promptBlocks, index, index + 1) })} disabled={index === draft.promptBlocks.length - 1}>↓</button></span></label><Textarea value={block.content} rows={5} onChange={(event) => setDraft({ ...draft, promptBlocks: draft.promptBlocks.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item) })} /></div>)}{draft.promptBlocks.length === 0 && <p className="quiet">This session has no prompt blocks. Add one from a harness or library revision.</p>}<details className="prompt-preview"><summary>Final compiled system prompt <span>{compiledPrompt.length} chars</span></summary><pre>{compiledPrompt || "No enabled system prompt blocks."}</pre></details></div>
    <div className="config-section"><h3>Tools <span>{draft.tools.filter((item) => item.enabled).length}</span></h3><div className="inline-add"><Select value={toolRevisionId} onChange={(event) => setToolRevisionId(event.target.value)}><option value="">Add from library…</option>{toolSpecs.data?.assets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select><Button variant="secondary" onClick={addTool} disabled={!toolRevisionId}><PlusIcon /></Button></div>{draft.tools.map((tool, index) => <div className="tool-binding" key={`${tool.toolRevisionId}-${index}`}><label className="tool-toggle"><input type="checkbox" checked={tool.enabled} onChange={(event) => setDraft({ ...draft, tools: draft.tools.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item) })} /><span><strong>{tool.name}</strong><small>{tool.mode} · {tool.description}</small></span><Select value={tool.mode} onChange={(event) => setDraft({ ...draft, tools: draft.tools.map((item, itemIndex) => itemIndex === index ? { ...item, mode: event.target.value as typeof item.mode, implementationRevisionId: null, targetId: null, mcpServerId: null } : item) })}><option value="manual">manual</option><option value="mock">mock</option><option value="real">real</option><option value="mcp">MCP</option></Select></label>{(tool.mode === "real" || tool.mode === "mock") && <Select aria-label={`${tool.name} implementation`} value={tool.implementationRevisionId ?? ""} onChange={(event) => setDraft({ ...draft, tools: draft.tools.map((item, itemIndex) => itemIndex === index ? { ...item, implementationRevisionId: event.target.value || null } : item) })}><option value="">Select implementation…</option>{implementations.data?.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select>}{tool.mode === "real" && <Select aria-label={`${tool.name} target`} value={tool.targetId ?? ""} onChange={(event) => setDraft({ ...draft, tools: draft.tools.map((item, itemIndex) => itemIndex === index ? { ...item, targetId: event.target.value || null } : item) })}><option value="">Local host</option>{targets.data?.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</Select>}{tool.mode === "mcp" && <Select aria-label={`${tool.name} MCP server`} value={tool.mcpServerId ?? ""} onChange={(event) => setDraft({ ...draft, tools: draft.tools.map((item, itemIndex) => itemIndex === index ? { ...item, mcpServerId: event.target.value || null } : item) })}><option value="">Select MCP server…</option>{mcpServers.data?.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</Select>}</div>)}</div>
    <Field label="Protocol overrides"><CodeMirror value={overrides} onChange={setOverrides} extensions={[json()]} height="130px" theme="dark" /></Field>
    {draft.compileWarnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
    {save.error && <div className="form-error">{save.error.message}</div>}<div className="inspector-actions"><Button onClick={() => save.mutate()} disabled={save.isPending}><Save size={14} /> Save draft</Button><Button variant="secondary" onClick={() => saveHarness.mutate()}><Archive size={14} /> Save as harness</Button></div>
  </div>;
}

function PlusIcon() { return <span aria-hidden="true">+</span>; }

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items;
  const result = [...items];
  const [item] = result.splice(from, 1);
  if (item === undefined) return items;
  result.splice(to, 0, item);
  return result.map((entry, order) => typeof entry === "object" && entry !== null && "order" in entry ? { ...entry, order } : entry) as T[];
}

function RunInspector({ run, events, streamError, onChanged }: { run: ModelRun | null; events: RunEventEnvelope[]; streamError: string | null; onChanged(): void }) {
  const cancel = useMutation({ mutationFn: () => api(`/api/runs/${run?.id}/cancel`, { method: "POST" }), onSuccess: onChanged });
  if (!run) return <div className="inspector-content quiet">No model runs on this branch yet.</div>;
  return <div className="inspector-content run-inspector">
    <div className="run-status"><span className={`status-badge status-${run.status}`}>{run.status}</span><code>{run.id.slice(0, 12)}</code></div>
    <dl><dt>Classification</dt><dd>{run.classification ?? "none"}</dd><dt>Started</dt><dd>{run.startedAt ? new Date(run.startedAt).toLocaleString() : "queued"}</dd><dt>Trace</dt><dd>{run.traceHash ? `${run.traceHash.slice(0, 18)}…` : "pending"}</dd></dl>
    <LiveRunEventPanel run={run} events={events} streamError={streamError} />
    <McpApprovalResolvers run={run} onChanged={onChanged} />
    <RunAnnotationEditor key={run.id} run={run} onChanged={onChanged} />
    {run.normalizedOutput !== null && <pre>{JSON.stringify(run.normalizedOutput, null, 2)}</pre>}
    {run.status === "awaiting-tool" && <ToolCallResolver run={run} onChanged={onChanged} />}
    {["queued", "streaming"].includes(run.status) && <Button variant="danger" onClick={() => cancel.mutate()}><CircleStop size={14} /> Cancel run</Button>}
    {run.traceHash && <Button variant="secondary" onClick={() => void downloadTrace(run.traceHash!)}><Download size={14} /> Download NDJSON trace</Button>}
  </div>;
}

function LiveRunEventPanel({ run, events, streamError }: { run: ModelRun; events: RunEventEnvelope[]; streamError: string | null }) {
  const live = ["queued", "streaming", "awaiting-tool"].includes(run.status);
  return <section className="live-run-events"><header><span><Activity size={13} /> Live run events</span><span className={live ? "live-indicator" : ""}>{live ? "connected" : `${events.length} captured`}</span></header>{streamError && <div className="form-error">{streamError}</div>}<div className="event-stream">
    {[...events].reverse().map((event) => {
      const serialized = JSON.stringify(event.data);
      const preview = serialized.length > 150 ? `${serialized.slice(0, 150)}…` : serialized;
      return <details className={`event-envelope ${event.type === "provider.trace" ? "event-trace" : ""}`} key={event.id}><summary><time>{new Date(event.timestamp).toLocaleTimeString()}</time><strong>{event.type}</strong><small>{preview}</small></summary><pre>{JSON.stringify(event, null, 2)}</pre></details>;
    })}
    {events.length === 0 && <p>{live ? "Waiting for run-scoped events…" : "No in-memory events were captured for this selection."}</p>}
  </div><footer>Newest first · retaining the last {Math.min(events.length, 500)} of 500 envelopes</footer></section>;
}

function RunAnnotationEditor({ run, onChanged }: { run: ModelRun; onChanged(): void }) {
  const [label, setLabel] = useState(run.operatorLabel ?? "");
  const [notes, setNotes] = useState(run.operatorNotes ?? "");
  const save = useMutation({
    mutationFn: () => api(`/api/runs/${run.id}/annotation`, { method: "PATCH", ...jsonBody({ operatorLabel: label.trim() || null, operatorNotes: notes || null }) }),
    onSuccess: onChanged
  });
  return <details className="run-annotation"><summary>Operator label & notes{run.operatorLabel && <span>{run.operatorLabel}</span>}</summary><div><Field label="Label"><Input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="jailbreak-success" /></Field><Field label="Notes"><Textarea value={notes} maxLength={20_000} onChange={(event) => setNotes(event.target.value)} rows={4} placeholder="Why this run matters, false-positive context, follow-up…" /></Field>{save.error && <div className="form-error">{save.error.message}</div>}<Button variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}><Save size={13} /> Save annotation</Button></div></details>;
}

function McpApprovalResolvers({ run, onChanged }: { run: ModelRun; onChanged(): void }) {
  const output = run.normalizedOutput && typeof run.normalizedOutput === "object" && !Array.isArray(run.normalizedOutput) ? run.normalizedOutput as JsonObject : null;
  const requests = Array.isArray(output?.mcpApprovalRequests) ? output.mcpApprovalRequests.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item) && item.status === "pending" && typeof item.id === "string")) : [];
  if (requests.length === 0) return null;
  return <div className="mcp-approval-list"><h3>MCP operator approval <span>{requests.length}</span></h3>{requests.map((request) => <McpApprovalResolver key={String(request.id)} runId={run.id} record={request} onChanged={onChanged} />)}</div>;
}

function ToolCallResolver({ run, onChanged }: { run: ModelRun; onChanged(): void }) {
  const output = run.normalizedOutput as JsonObject | null;
  const calls = Array.isArray(output?.toolCalls) ? output.toolCalls as JsonObject[] : [];
  return <div className="tool-resolvers"><h3>Approval required</h3>{calls.map((call) => <SingleToolResolver key={String(call.callId)} runId={run.id} call={call} onChanged={onChanged} />)}</div>;
}

function SingleToolResolver({ runId, call, onChanged }: { runId: string; call: JsonObject; onChanged(): void }) {
  const mode = typeof call.mode === "string" ? call.mode : "manual";
  const [result, setResult] = useState(() => JSON.stringify(call.mockResult ?? {}, null, 2));
  const [overrideArguments, setOverrideArguments] = useState(() => JSON.stringify(call.arguments ?? {}, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const submit = useMutation({ mutationFn: (resolution: JsonValue) => api(`/api/runs/${runId}/tool-calls/${encodeURIComponent(String(call.callId))}/resolve`, { method: "POST", ...jsonBody({ resolution }) }), onSuccess: onChanged });
  const approve = (decision: "approve-once" | "approve-session") => {
    try {
      const parsed = JSON.parse(overrideArguments) as JsonValue;
      setParseError(null);
      submit.mutate({ decision, overrideArguments: parsed });
    } catch (error) {
      setParseError(`Operator argument override is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const useResult = () => {
    try {
      const parsed = JSON.parse(result) as JsonValue;
      setParseError(null);
      submit.mutate({ result: parsed, isError: false });
    } catch (error) {
      setParseError(`${mode === "mock" ? "Mock" : "Manual"} result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const approval = call.approval && typeof call.approval === "object" && !Array.isArray(call.approval) ? call.approval as JsonObject : null;
  const command = approval?.effectiveCommand && typeof approval.effectiveCommand === "object" && !Array.isArray(approval.effectiveCommand) ? approval.effectiveCommand : null;
  const target = approval?.target && typeof approval.target === "object" && !Array.isArray(approval.target) ? approval.target : null;
  const mcpServer = approval?.mcpServer && typeof approval.mcpServer === "object" && !Array.isArray(approval.mcpServer) ? approval.mcpServer : null;
  return <div className="tool-resolver">
    <div className="resolver-heading"><strong>{String(call.name)}</strong><span className="pill">{mode}</span></div>
    <label>Original model arguments</label><pre>{JSON.stringify(call.arguments, null, 2)}</pre>
    {(mode === "real" || mode === "mcp") && <>
      {command && <><label>Resolved execution request</label><pre>{JSON.stringify(command, null, 2)}</pre></>}
      {target && <><label>Execution target, environment names, and launcher</label><pre>{JSON.stringify(target, null, 2)}</pre></>}
      {mcpServer && <><label>MCP server revision and transport</label><pre>{JSON.stringify(mcpServer, null, 2)}</pre></>}
      {typeof call.handlerSource === "string" && <details><summary>Handler source · {String(call.toolRevisionHash).slice(0, 12)}</summary><pre>{call.handlerSource}</pre></details>}
      <Field label="Operator argument override"><Textarea value={overrideArguments} onChange={(event) => { setOverrideArguments(event.target.value); setParseError(null); }} rows={3} /></Field>
      <div className="approval-actions"><Button onClick={() => approve("approve-once")}>Approve once</Button><Button variant="secondary" onClick={() => approve("approve-session")}>Trust revision</Button><Button variant="danger" onClick={() => { setParseError(null); submit.mutate({ decision: "reject", reason: "Rejected by operator" }); }}>Reject</Button></div>
    </>}
    {(mode === "manual" || mode === "mock") && <><Field label={mode === "mock" ? "Deterministic mock result" : "Operator-supplied result"}><Textarea value={result} onChange={(event) => { setResult(event.target.value); setParseError(null); }} rows={3} /></Field><Button onClick={useResult}><Check size={13} /> {mode === "mock" ? "Use mock result" : "Use manual result"}</Button></>}
    {parseError && <div className="form-error">{parseError}</div>}{submit.error && <div className="form-error">{submit.error.message}</div>}
  </div>;
}

function EvidenceInspector({ data, branch, selectedNode, onChanged }: { data: WorkbenchData; branch: BranchRef; selectedNode: MessageNode | null; onChanged(): void }) {
  const queryClient = useQueryClient();
  const findings = useQuery({ queryKey: ["findings", data.session.projectId], queryFn: () => api<{ findings: Finding[] }>(`/api/findings?projectId=${encodeURIComponent(data.session.projectId)}`) });
  const jobs = useQuery({
    queryKey: ["automation", data.session.id],
    queryFn: () => api<{ jobs: AutomationJob[] }>(`/api/automation?sessionId=${encodeURIComponent(data.session.id)}`),
    refetchInterval: (query) => query.state.data?.jobs.some((job) => ["queued", "running"].includes(job.status)) ? 1_000 : false
  });
  const [findingTitle, setFindingTitle] = useState("");
  const [severity, setSeverity] = useState<Finding["severity"]>("medium");
  const [summary, setSummary] = useState("");
  const [expected, setExpected] = useState("");
  const [observed, setObserved] = useState("");
  const [tags, setTags] = useState("");
  const [automationKind, setAutomationKind] = useState<AutomationJob["kind"]>("payload-fanout");
  const [concurrency, setConcurrency] = useState(3);
  const [sourceBranchId, setSourceBranchId] = useState(branch.id);
  const [destinationBranchId, setDestinationBranchId] = useState(branch.id);
  const [fanoutBranchIds, setFanoutBranchIds] = useState<string[]>([branch.id]);
  const [payload, setPayload] = useState("");
  const [pointer, setPointer] = useState("/config/temperature");
  const [values, setValues] = useState("[0, 0.5, 1]");

  const restore = useMutation({
    mutationFn: (checkpointId: string) => api(`/api/checkpoints/${checkpointId}/restore?sessionId=${encodeURIComponent(data.session.id)}&branchId=${encodeURIComponent(branch.id)}`, { method: "POST" }),
    onSuccess: onChanged
  });
  const createFinding = useMutation({
    mutationFn: () => api("/api/findings", { method: "POST", ...jsonBody({
      projectId: data.session.projectId,
      sessionId: data.session.id,
      branchId: branch.id,
      nodeId: selectedNode?.id ?? branch.headNodeId,
      title: findingTitle,
      severity,
      summary,
      expected,
      observed,
      tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean)
    }) }),
    onSuccess: () => {
      setFindingTitle("");
      setSummary("");
      setExpected("");
      setObserved("");
      setTags("");
      void queryClient.invalidateQueries({ queryKey: ["findings", data.session.projectId] });
    }
  });
  const exportFinding = useMutation({
    mutationFn: (finding: Finding) => downloadApiFile(`/api/findings/${finding.id}/export?projectId=${encodeURIComponent(finding.projectId)}`, `${finding.title}.lathe-finding`)
  });
  const startAutomation = useMutation({
    mutationFn: () => {
      let plan: JsonObject;
      if (automationKind === "replay") {
        const source = data.branches.find((item) => item.id === sourceBranchId);
        if (!source) throw new Error("Select a source branch");
        const steps = pathToRoot(data.nodes, source.headNodeId).flatMap((node) => {
          if (node.role === "user") return [{ kind: "user", parts: node.parts }];
          const toolResults = node.parts.filter((part) => part.type === "tool-result");
          return toolResults.length > 0 ? [{ kind: "tool-result", parts: toolResults }] : [];
        });
        if (steps.length === 0) throw new Error("The source branch has no replayable operator steps");
        plan = { sourceBranchId, destinationBranchId, steps } as unknown as JsonObject;
      } else if (automationKind === "payload-fanout") {
        if (fanoutBranchIds.length === 0) throw new Error("Select at least one target branch");
        if (!payload.trim()) throw new Error("Enter a payload");
        plan = { payload, branchIds: fanoutBranchIds };
      } else {
        const parsedValues = JSON.parse(values) as JsonValue;
        if (!Array.isArray(parsedValues)) throw new Error("Variation values must be a JSON array");
        if (!payload.trim()) throw new Error("Enter a payload");
        plan = {
          pointer,
          values: parsedValues,
          template: { sourceBranchId, payload, config: data.session.draftConfig as unknown as JsonValue }
        };
      }
      return api("/api/automation", { method: "POST", ...jsonBody({
        projectId: data.session.projectId,
        sessionId: data.session.id,
        kind: automationKind,
        concurrency,
        plan
      }) });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["automation", data.session.id] });
      onChanged();
    }
  });
  const cancelJob = useMutation({
    mutationFn: (jobId: string) => api(`/api/automation/${jobId}/cancel`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["automation", data.session.id] })
  });
  const resumeJob = useMutation({
    mutationFn: (jobId: string) => api(`/api/automation/${jobId}/resume`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["automation", data.session.id] });
      onChanged();
    }
  });

  return <div className="inspector-content evidence-inspector">
    <div className="config-section"><h3>Checkpoints <span>{data.checkpoints.length}</span></h3>
      {data.checkpoints.map((checkpoint) => <article className="evidence-row evidence-action-row" key={checkpoint.id}><span><strong>{checkpoint.name}</strong><small>node {checkpoint.nodeId?.slice(0, 8) ?? "root"} · {new Date(checkpoint.createdAt).toLocaleString()}</small></span><Button variant="ghost" title={`Restore ${checkpoint.name} on ${branch.name}`} onClick={() => restore.mutate(checkpoint.id)} disabled={restore.isPending}><RotateCcw size={13} /></Button></article>)}
      {data.checkpoints.length === 0 && <p className="section-empty">No named checkpoints yet.</p>}
      {restore.error && <div className="form-error">{restore.error.message}</div>}
    </div>

    <div className="config-section"><h3>Findings <span>{findings.data?.findings.length ?? 0}</span></h3>
      {findings.data?.findings.map((finding) => <article className="evidence-row evidence-action-row" key={finding.id}><span><strong>{finding.title}</strong><small><span className={`severity-dot severity-${finding.severity}`} />{finding.severity} · {data.branches.find((item) => item.id === finding.branchId)?.name ?? "other session"}</small></span><Button variant="ghost" title="Export reproducible finding" onClick={() => exportFinding.mutate(finding)}><Download size={13} /></Button></article>)}
      {findings.data?.findings.length === 0 && <p className="section-empty">No findings preserved for this project.</p>}
      <details className="evidence-editor"><summary><FilePlus2 size={13} /> Preserve current evidence</summary><form onSubmit={(event) => { event.preventDefault(); createFinding.mutate(); }}>
        <div className="two-fields compact"><Field label="Title"><Input value={findingTitle} onChange={(event) => setFindingTitle(event.target.value)} placeholder="Prompt leakage" required /></Field><Field label="Severity"><Select value={severity} onChange={(event) => setSeverity(event.target.value as Finding["severity"])}><option value="informational">Informational</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></Select></Field></div>
        <Field label="Summary"><Textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={2} /></Field>
        <Field label="Expected behavior"><Textarea value={expected} onChange={(event) => setExpected(event.target.value)} rows={2} /></Field>
        <Field label="Observed behavior"><Textarea value={observed} onChange={(event) => setObserved(event.target.value)} rows={3} /></Field>
        <Field label="Tags" hint="Comma-separated"><Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="injection, exfiltration" /></Field>
        <p className="selection-note">Captures <strong>{branch.name}</strong> at node <code>{(selectedNode?.id ?? branch.headNodeId)?.slice(0, 8) ?? "root"}</code>.</p>
        {createFinding.error && <div className="form-error">{createFinding.error.message}</div>}<Button disabled={!findingTitle || createFinding.isPending}>{createFinding.isPending ? "Preserving…" : "Create finding"}</Button>
      </form></details>
      {exportFinding.error && <div className="form-error">{exportFinding.error.message}</div>}
    </div>

    <div className="config-section"><h3>Automation jobs <span>{jobs.data?.jobs.length ?? 0}</span></h3>
      {jobs.data?.jobs.map((job) => <article className="evidence-row job-row" key={job.id}><div><strong>{automationLabel(job.kind)}</strong><small>{new Date(job.createdAt).toLocaleString()} · concurrency {job.concurrency}</small></div><span className={`status-badge status-${job.status}`}>{job.status}</span>{Object.keys(job.progress).length > 0 && <code>{JSON.stringify(job.progress)}</code>}{job.error && <code className="job-error">{JSON.stringify(job.error)}</code>}{["queued", "running"].includes(job.status) && <Button variant="danger" onClick={() => cancelJob.mutate(job.id)}><CircleStop size={12} /> Cancel</Button>}{["paused", "interrupted"].includes(job.status) && <Button variant="secondary" onClick={() => resumeJob.mutate(job.id)} disabled={resumeJob.isPending}><Play size={12} /> Resume from saved progress</Button>}</article>)}
      {jobs.data?.jobs.length === 0 && <p className="section-empty">No automation jobs in this session.</p>}
      <details className="evidence-editor"><summary><Play size={13} /> Start partial automation</summary><form onSubmit={(event) => { event.preventDefault(); startAutomation.mutate(); }}>
        <div className="two-fields compact"><Field label="Operation"><Select value={automationKind} onChange={(event) => setAutomationKind(event.target.value as AutomationJob["kind"])}><option value="payload-fanout">Payload fan-out</option><option value="batch-vary">Batch variation</option><option value="replay">Replay saved steps</option></Select></Field><Field label="Concurrency"><Input type="number" min="1" max="10" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></Field></div>
        {automationKind === "replay" && <><Field label="Source branch"><Select value={sourceBranchId} onChange={(event) => setSourceBranchId(event.target.value)}>{data.branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="Destination branch"><Select value={destinationBranchId} onChange={(event) => setDestinationBranchId(event.target.value)}>{data.branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><p className="selection-note">Replays operator messages and captured tool results in order. Model responses are generated again.</p></>}
        {automationKind === "payload-fanout" && <><Field label="Payload"><Textarea value={payload} onChange={(event) => setPayload(event.target.value)} rows={4} placeholder="Payload to run from every selected branch head" /></Field><div className="branch-checklist"><span>Target branches</span>{data.branches.map((item) => <label key={item.id}><input type="checkbox" checked={fanoutBranchIds.includes(item.id)} onChange={(event) => setFanoutBranchIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} />{item.name}</label>)}</div></>}
        {automationKind === "batch-vary" && <><Field label="Source branch"><Select value={sourceBranchId} onChange={(event) => setSourceBranchId(event.target.value)}>{data.branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="Payload"><Textarea value={payload} onChange={(event) => setPayload(event.target.value)} rows={3} /></Field><Field label="JSON Pointer" hint="Targets the payload/config job template."><Input value={pointer} onChange={(event) => setPointer(event.target.value)} placeholder="/config/temperature" /></Field><Field label="Variation values (JSON array)"><CodeMirror value={values} onChange={setValues} extensions={[json()]} height="85px" theme="dark" /></Field></>}
        {startAutomation.error && <div className="form-error">{startAutomation.error.message}</div>}<Button disabled={startAutomation.isPending}>{startAutomation.isPending ? "Starting…" : "Start job"}</Button>
      </form></details>
    </div>

    <div className="config-section"><h3>Attachments <span>{data.attachments.length}</span></h3>{data.attachments.map((attachment) => <article className="evidence-row" key={attachment.id}><strong>{attachment.fileName}</strong><small>{attachment.mediaType} · {formatBytes(attachment.size)}</small><code>{attachment.sha256.slice(0, 16)}…</code></article>)}</div>
    <div className="config-section"><h3>Immutable snapshots</h3><p className="section-empty">Every generated assistant node records its configuration revision and redacted transport trace. Rewind never mutates this evidence.</p></div>
  </div>;
}

function automationLabel(kind: AutomationJob["kind"]): string {
  if (kind === "payload-fanout") return "Payload fan-out";
  if (kind === "batch-vary") return "Batch variation";
  return "Replay";
}

async function downloadTrace(hash: string) {
  const token = sessionStorage.getItem("lathe.launch-token") ?? "";
  const response = await fetch(`/api/traces/${hash}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a"); link.href = url; link.download = `${hash}.ndjson`; link.click(); URL.revokeObjectURL(url);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
