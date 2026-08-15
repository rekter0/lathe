import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { Box, Braces, Cable, Download, KeyRound, Library, PackageOpen, Pencil, Plus, RefreshCw, ShieldCheck, TerminalSquare, Trash2, Upload, X } from "lucide-react";
import { api, downloadApiFile, jsonBody } from "../api.js";
import { Button, Field, Input, Select, Textarea } from "../components/forms.js";
import { useOperatorDialog } from "../components/operator-dialog.js";
import type { AssetRevision, SafeProvider } from "../types.js";
import type { ModelCapabilities, SecretMetadata } from "@lathe/domain";

interface DiscoveredModel {
  id: string;
  label?: string;
  source: "manual" | "discovered";
  capabilities?: ModelCapabilities;
}

const defaultDiscoveredCapabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  images: false,
  files: false,
  jsonMode: false,
  maxContextTokens: null
};

function parseObjectJson(source: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

interface DeleteItem {
  id: string;
  name: string;
}

function useConfirmedDelete(options: {
  subject: string;
  endpoint(item: DeleteItem): string;
  invalidateKey: readonly unknown[];
  description: string;
  onDeleted?(item: DeleteItem): void;
}) {
  const dialogs = useOperatorDialog();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (item: DeleteItem) => api(options.endpoint(item), { method: "DELETE" }),
    onSuccess: (_result, item) => {
      void queryClient.invalidateQueries({ queryKey: [...options.invalidateKey] });
      options.onDeleted?.(item);
    },
    onError: (error, item) => void dialogs.confirm({
      title: `Could not delete ${options.subject} “${item.name}”`,
      description: error.message,
      confirmLabel: "Close",
      danger: true
    })
  });
  const request = async (item: DeleteItem) => {
    mutation.reset();
    const approved = await dialogs.confirm({
      title: `Delete ${options.subject} “${item.name}”?`,
      description: options.description,
      confirmLabel: `Delete ${options.subject}`,
      danger: true
    });
    if (approved) mutation.mutate(item);
  };
  return { ...mutation, request };
}

export function SettingsPage() {
  return <div className="settings-view">
    <div className="page-heading"><span className="eyebrow">GLOBAL LIBRARY</span><h1>Workbench settings</h1><p>Providers and versioned assets are shared across projects. Secrets never appear again after saving.</p></div>
    <Tabs.Root defaultValue="providers" className="settings-tabs">
      <Tabs.List className="tabs-list">
        <Tabs.Trigger value="providers"><KeyRound size={15} /> Providers</Tabs.Trigger>
        <Tabs.Trigger value="prompts"><Library size={15} /> Prompts</Tabs.Trigger>
        <Tabs.Trigger value="tools"><TerminalSquare size={15} /> Tools</Tabs.Trigger>
        <Tabs.Trigger value="targets"><Box size={15} /> Targets</Tabs.Trigger>
        <Tabs.Trigger value="mcp"><Cable size={15} /> MCP</Tabs.Trigger>
        <Tabs.Trigger value="artifacts"><PackageOpen size={15} /> Artifacts</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="providers"><ProviderSettings /></Tabs.Content>
      <Tabs.Content value="prompts"><AssetSettings kind="prompt" /></Tabs.Content>
      <Tabs.Content value="tools"><AssetSettings kind="tool-spec" /></Tabs.Content>
      <Tabs.Content value="targets"><ConnectionSettings section="targets" /></Tabs.Content>
      <Tabs.Content value="mcp"><ConnectionSettings section="mcp" /></Tabs.Content>
      <Tabs.Content value="artifacts"><ArtifactSettings /></Tabs.Content>
    </Tabs.Root>
  </div>;
}

function ProviderSettings() {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api<{ providers: SafeProvider[] }>("/api/providers") });
  const [editingProvider, setEditingProvider] = useState<SafeProvider | null>(null);
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<SafeProvider["protocol"]>("openai-responses");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [endpointOverride, setEndpointOverride] = useState("");
  const [credential, setCredential] = useState("");
  const [modelId, setModelId] = useState("");
  const [headers, setHeaders] = useState("{}");
  const [extraBody, setExtraBody] = useState("{}");
  const [clearCredential, setClearCredential] = useState(false);

  const resetFields = () => {
    setEditingProvider(null);
    setLabel("");
    setProtocol("openai-responses");
    setBaseUrl("https://api.openai.com");
    setEndpointOverride("");
    setCredential("");
    setModelId("");
    setHeaders("{}");
    setExtraBody("{}");
    setClearCredential(false);
  };
  const deleteProvider = useConfirmedDelete({
    subject: "provider",
    endpoint: (item) => `/api/providers/${item.id}`,
    invalidateKey: ["providers"],
    description: "This removes the provider revision from the global library. Lathe will refuse the deletion if a session, checkpoint, saved configuration, or automation plan still references it.",
    onDeleted: (item) => { if (editingProvider?.id === item.id) resetFields(); }
  });

  const saveProvider = useMutation({
    mutationFn: () => {
      const normalizedModelId = modelId.trim();
      const models = editingProvider
        ? normalizedModelId && !editingProvider.models.some((model) => model.id === normalizedModelId)
          ? [...editingProvider.models, { id: normalizedModelId, label: normalizedModelId, discovered: false, capabilities: defaultDiscoveredCapabilities }]
          : undefined
        : normalizedModelId
          ? [{ id: normalizedModelId, label: normalizedModelId, discovered: false, capabilities: defaultDiscoveredCapabilities }]
          : [];
      const body: Record<string, unknown> = {
        label,
        protocol,
        baseUrl,
        endpointOverride: endpointOverride || null,
        headers: JSON.parse(headers),
        extraBody: JSON.parse(extraBody)
      };
      if (models !== undefined) body.models = models;
      if (!editingProvider || credential || clearCredential) body.credential = clearCredential ? "" : credential;
      return api(editingProvider ? `/api/providers/${editingProvider.id}/revisions` : "/api/providers", {
      method: "POST",
        ...jsonBody(body)
      });
    },
    onSuccess: () => {
      resetFields();
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    }
  });
  const discover = useMutation({
    mutationFn: (providerId: string) => api<{ models: DiscoveredModel[]; warnings: string[] }>(`/api/providers/${providerId}/discover`, { method: "POST" })
  });
  const saveCatalog = useMutation({
    mutationFn: ({ providerId, models }: { providerId: string; models: DiscoveredModel[] }) => api(`/api/providers/${providerId}/revisions`, {
      method: "POST",
      ...jsonBody({ models: models.map((model) => ({
        id: model.id,
        label: model.label ?? model.id,
        discovered: model.source === "discovered",
        capabilities: model.capabilities ?? defaultDiscoveredCapabilities
      })) })
    }),
    onSuccess: () => {
      discover.reset();
      resetFields();
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    }
  });

  const beginEdit = (provider: SafeProvider) => {
    saveProvider.reset();
    setEditingProvider(provider);
    setLabel(provider.label);
    setProtocol(provider.protocol);
    setBaseUrl(provider.baseUrl);
    setEndpointOverride(provider.endpointOverride ?? "");
    setCredential("");
    setModelId("");
    setHeaders(JSON.stringify(provider.headers, null, 2));
    setExtraBody(JSON.stringify(provider.extraBody, null, 2));
    setClearCredential(false);
  };
  const cancelEdit = () => { saveProvider.reset(); resetFields(); };
  const submit = (event: FormEvent) => { event.preventDefault(); saveProvider.mutate(); };

  return <div className="settings-grid">
    <section className="panel library-list">
      <div className="panel-title"><KeyRound size={16} /> Saved providers</div>
      {providers.data?.providers.map((provider) => <article className={`library-card${editingProvider?.id === provider.id ? " editing" : ""}`} key={provider.id}>
        <div><strong>{provider.label}</strong><small>{provider.protocol} · revision {provider.revision}</small></div><div className="library-actions"><Button variant="ghost" onClick={() => beginEdit(provider)} title="Edit provider as a new revision" aria-label={`Edit ${provider.label}`}><Pencil size={13} /></Button><Button variant="ghost" onClick={() => discover.mutate(provider.id)} title="Discover compatible models" aria-label={`Discover models for ${provider.label}`} disabled={discover.isPending && discover.variables === provider.id}><RefreshCw size={13} className={discover.isPending && discover.variables === provider.id ? "spin-icon" : ""} /></Button><Button variant="ghost" className="delete-icon-button" onClick={() => void deleteProvider.request({ id: provider.id, name: provider.label })} title={`Delete ${provider.label}`} aria-label={`Delete ${provider.label} provider`} disabled={deleteProvider.isPending && deleteProvider.variables?.id === provider.id}><Trash2 size={13} /></Button></div>
        <code>{provider.baseUrl}</code>
        <p>{provider.models.length} models · credential {provider.hasCredential ? "stored" : "not set"}</p>
        {discover.variables === provider.id && discover.data && <div className="discovery-result"><strong>{discover.data.models.length} models discovered</strong>{discover.data.models.slice(0, 12).map((model) => <code key={model.id}>{model.id}</code>)}{discover.data.models.length > 12 && <small>+{discover.data.models.length - 12} more</small>}{discover.data.warnings.map((warning) => <small className="warning" key={warning}>{warning}</small>)}<Button variant="secondary" onClick={() => saveCatalog.mutate({ providerId: provider.id, models: discover.data.models })} disabled={discover.data.models.length === 0 || saveCatalog.isPending}><SaveCatalogIcon />{saveCatalog.isPending ? "Saving revision…" : "Save discovered catalog"}</Button>{saveCatalog.error && <div className="form-error">{saveCatalog.error.message}</div>}</div>}
      </article>)}
      {providers.data?.providers.length === 0 && <p className="quiet">No provider profiles yet.</p>}
      {deleteProvider.error && <div className="form-error library-delete-error">{deleteProvider.error.message}</div>}
    </section>
    <section className="panel editor-panel">
      <div className="panel-title">{editingProvider ? <Pencil size={16} /> : <Plus size={16} />}{editingProvider ? `Edit provider · revision ${editingProvider.revision}` : "New provider profile"}{editingProvider && <Button type="button" variant="ghost" className="panel-title-action" onClick={cancelEdit} title="Cancel editing" aria-label="Cancel provider editing"><X size={13} /></Button>}</div>
      <form onSubmit={submit}>
        <div className="two-fields"><Field label="Label"><Input value={label} onChange={(event) => setLabel(event.target.value)} required /></Field>
          <Field label="Protocol"><Select value={protocol} onChange={(event) => setProtocol(event.target.value as SafeProvider["protocol"])}>
            <option value="openai-responses">OpenAI Responses</option><option value="openai-chat">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option>
          </Select></Field></div>
        <Field label="Base URL"><Input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field>
        <Field label="Generation endpoint override" hint="Optional full path/URL for compatible gateways with a non-standard generation endpoint."><Input value={endpointOverride} onChange={(event) => setEndpointOverride(event.target.value)} placeholder="https://gateway.example/v1/responses" /></Field>
        <div className="two-fields"><Field label="API credential" hint={editingProvider ? "Leave blank to keep the stored credential." : undefined}><Input type="password" value={credential} onChange={(event) => { setCredential(event.target.value); if (event.target.value) setClearCredential(false); }} autoComplete="off" disabled={clearCredential} /></Field>
          <Field label={editingProvider ? "Add model ID" : "Initial model ID"} hint={editingProvider ? `Leave blank to keep the ${editingProvider.models.length}-model catalog.` : undefined}><Input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="model-id" /></Field></div>
        {editingProvider?.hasCredential && <label className="credential-clear"><input type="checkbox" checked={clearCredential} onChange={(event) => { setClearCredential(event.target.checked); if (event.target.checked) setCredential(""); }} /> Clear the stored credential in the new revision</label>}
        <Field label="Custom headers (JSON)" hint={editingProvider ? "Redacted values are preserved. Remove a key to delete it, or replace its marker to update it." : undefined}><CodeMirror value={headers} onChange={setHeaders} extensions={[json()]} height="88px" theme="dark" /></Field>
        <Field label="Extra request body (JSON)" hint={editingProvider ? "Redacted values are preserved. Core model/input/tools/stream fields remain protected." : "Core model/input/tools/stream fields are protected."}><CodeMirror value={extraBody} onChange={setExtraBody} extensions={[json()]} height="88px" theme="dark" /></Field>
        {editingProvider && <p className="warning provider-revision-note">Saving creates a new immutable revision. Existing sessions remain pinned to revision {editingProvider.revision} until you select the new one.</p>}
        {saveProvider.error && <div className="form-error">{saveProvider.error.message}</div>}
        <Button disabled={!label || !baseUrl || saveProvider.isPending}>{saveProvider.isPending ? "Saving…" : editingProvider ? "Save new revision" : "Save provider"}</Button>
      </form>
    </section>
  </div>;
}

function SaveCatalogIcon() { return <span aria-hidden="true">↳</span>; }

function AssetSettings({ kind }: { kind: "prompt" | "tool-spec" }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["assets", kind], queryFn: () => api<{ assets: AssetRevision[] }>(`/api/assets?kind=${kind}`) });
  const [editingAsset, setEditingAsset] = useState<AssetRevision | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [schema, setSchema] = useState('{\n  "type": "object",\n  "properties": {}\n}');
  const resetFields = () => {
    setEditingAsset(null);
    setName("");
    setDescription("");
    setContent("");
    setSchema('{\n  "type": "object",\n  "properties": {}\n}');
  };
  const deleteAsset = useConfirmedDelete({
    subject: kind === "prompt" ? "prompt revision" : "tool specification",
    endpoint: (item) => `/api/library/assets/${item.id}`,
    invalidateKey: ["assets", kind],
    description: "This removes the immutable revision from the global library. Lathe will refuse the deletion while a harness, session draft, saved snapshot, project, or automation plan references it.",
    onDeleted: (item) => { if (editingAsset?.id === item.id) resetFields(); }
  });
  const save = useMutation({
    mutationFn: () => api("/api/library/assets", {
      method: "POST",
      ...jsonBody({
        ...(editingAsset ? { assetId: editingAsset.assetId, baseRevisionId: editingAsset.id } : {}),
        kind, name, description, tags: editingAsset?.tags ?? [], trusted: true,
        provenance: editingAsset
          ? { ...editingAsset.provenance, operatorAuthored: true, editedFromRevisionId: editingAsset.id, operatorEditedAt: new Date().toISOString() }
          : { operatorAuthored: true },
        value: kind === "prompt" ? { content } : { name, description, inputSchema: JSON.parse(schema) }
      })
    }),
    onSuccess: () => { resetFields(); void queryClient.invalidateQueries({ queryKey: ["assets", kind] }); }
  });
  const beginEdit = (asset: AssetRevision) => {
    const value = asset.value && typeof asset.value === "object" && !Array.isArray(asset.value) ? asset.value : {};
    save.reset();
    setEditingAsset(asset);
    setName(asset.name);
    setDescription(asset.description);
    if (kind === "prompt") setContent(typeof value.content === "string" ? value.content : "");
    else setSchema(JSON.stringify(value.inputSchema ?? { type: "object", properties: {} }, null, 2));
  };
  return <><div className="settings-grid">
    <section className="panel library-list"><div className="panel-title"><Library size={16} /> Versioned {kind === "prompt" ? "prompts" : "tool specifications"}</div>
      {query.data?.assets.map((asset) => {
        const latest = query.data.assets.filter((candidate) => candidate.assetId === asset.assetId).toSorted((left, right) => right.revision - left.revision)[0];
        const mayEdit = latest?.id === asset.id;
        return <article className={`library-card${editingAsset?.id === asset.id ? " editing" : ""}`} key={asset.id}><div><strong>{asset.name}</strong><small>revision {asset.revision}</small></div><div className="library-actions"><span className={`pill ${asset.trusted ? "pill-safe" : ""}`}>{asset.trusted ? "trusted" : "disabled"}</span>{mayEdit && <Button variant="ghost" onClick={() => beginEdit(asset)} title="Edit as a new immutable revision" aria-label={`Edit ${asset.name}`}><Pencil size={13} /></Button>}<Button variant="ghost" className="delete-icon-button" onClick={() => void deleteAsset.request(asset)} title={`Delete ${asset.name} revision ${asset.revision}`} aria-label={`Delete ${asset.name} revision ${asset.revision}`} disabled={deleteAsset.isPending && deleteAsset.variables?.id === asset.id}><Trash2 size={13} /></Button></div><p>{asset.description || "No description"}</p><code>{asset.contentHash.slice(0, 16)}…</code></article>;
      })}
      {deleteAsset.error && <div className="form-error library-delete-error">{deleteAsset.error.message}</div>}
    </section>
    <section className="panel editor-panel"><div className="panel-title">{editingAsset ? <Pencil size={16} /> : <Plus size={16} />}{editingAsset ? `Edit ${kind === "prompt" ? "prompt" : "tool"} · revision ${editingAsset.revision}` : `New ${kind === "prompt" ? "prompt" : "tool"}`}{editingAsset && <Button type="button" variant="ghost" className="panel-title-action" onClick={() => { save.reset(); resetFields(); }} title="Cancel editing" aria-label={`Cancel ${kind} editing`}><X size={13} /></Button>}</div>
      <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <Field label="Label"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        {kind === "prompt" ? <Field label="System prompt"><Textarea value={content} onChange={(event) => setContent(event.target.value)} rows={12} required /></Field>
          : <Field label="JSON Schema"><CodeMirror value={schema} onChange={setSchema} extensions={[json()]} height="260px" theme="dark" /></Field>}
        {editingAsset && <p className="warning provider-revision-note">Saving creates revision {editingAsset.revision + 1}. Existing harnesses and sessions remain pinned to revision {editingAsset.revision}.</p>}
        {save.error && <div className="form-error">{save.error.message}</div>}<Button disabled={!name || save.isPending}>{save.isPending ? "Saving…" : editingAsset ? "Save new revision" : "Save immutable revision"}</Button>
      </form>
    </section>
  </div>{kind === "tool-spec" && <ToolImplementationEditor />}</>;
}

function ToolImplementationEditor() {
  const dialogs = useOperatorDialog();
  const queryClient = useQueryClient();
  const implementations = useQuery({ queryKey: ["assets", "tool-implementation"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=tool-implementation") });
  const defaultSource = `function build(input) {\n  return { program: "/usr/bin/printf", args: ["%s", String(input.arguments.value)] };\n}\n\nfunction formatResult(result) {\n  return { output: result.stdout.text, exitCode: result.exitCode };\n}`;
  const [editingAsset, setEditingAsset] = useState<AssetRevision | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"real" | "mock">("real");
  const [source, setSource] = useState(defaultSource);
  const [mockResult, setMockResult] = useState('{\n  "ok": true\n}');
  const resetFields = () => {
    setEditingAsset(null);
    setName("");
    setMode("real");
    setSource(defaultSource);
    setMockResult('{\n  "ok": true\n}');
  };
  const deleteImplementation = useConfirmedDelete({
    subject: "tool implementation",
    endpoint: (item) => `/api/library/assets/${item.id}`,
    invalidateKey: ["assets", "tool-implementation"],
    description: "This removes the implementation revision from the global library. Lathe will refuse the deletion while a harness, session, or saved configuration is bound to it.",
    onDeleted: (item) => { if (editingAsset?.id === item.id) resetFields(); }
  });
  const save = useMutation({
    mutationFn: () => api("/api/library/assets", { method: "POST", ...jsonBody({
      ...(editingAsset ? { assetId: editingAsset.assetId, baseRevisionId: editingAsset.id } : {}),
      kind: "tool-implementation", name,
      description: editingAsset?.description ?? (mode === "real" ? "QuickJS command handler" : "Deterministic mock response"),
      tags: editingAsset ? [...editingAsset.tags.filter((tag) => tag !== "real" && tag !== "mock"), mode] : [mode],
      provenance: editingAsset
        ? { ...editingAsset.provenance, operatorAuthored: true, editedFromRevisionId: editingAsset.id, operatorEditedAt: new Date().toISOString() }
        : { operatorAuthored: true },
      trusted: editingAsset?.trusted ?? true,
      value: mode === "real" ? { source } : { result: JSON.parse(mockResult) }
    }) }),
    onSuccess: () => { resetFields(); void queryClient.invalidateQueries({ queryKey: ["assets", "tool-implementation"] }); }
  });
  const trust = useMutation({
    mutationFn: (asset: AssetRevision) => api("/api/library/assets", { method: "POST", ...jsonBody({
      assetId: asset.assetId,
      kind: "tool-implementation",
      name: asset.name,
      description: asset.description,
      tags: asset.tags,
      provenance: { ...asset.provenance, trustedFromRevisionId: asset.id, operatorTrustedAt: new Date().toISOString() },
      value: asset.value,
      trusted: true
    }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["assets", "tool-implementation"] })
  });
  const beginEdit = (asset: AssetRevision) => {
    const value = asset.value && typeof asset.value === "object" && !Array.isArray(asset.value) ? asset.value : {};
    const nextMode = typeof value.source === "string" ? "real" : "mock";
    save.reset();
    setEditingAsset(asset);
    setName(asset.name);
    setMode(nextMode);
    setSource(typeof value.source === "string" ? value.source : defaultSource);
    setMockResult(JSON.stringify(value.result ?? {}, null, 2));
  };
  const requestTrust = async (asset: AssetRevision) => {
    const approved = await dialogs.confirm({
      title: `Trust ${asset.name}?`,
      description: "This creates a trusted immutable revision. Its handler may prepare commands, while real execution remains subject to the session's approval policy.",
      confirmLabel: "Trust new revision",
      danger: true
    });
    if (approved) trust.mutate(asset);
  };
  return <section className="panel implementation-panel"><div className="panel-title"><Braces size={16} /> Tool implementations</div><div className="implementation-layout"><div className="library-list compact-list">{implementations.data?.assets.map((asset) => {
    const latest = implementations.data.assets.filter((candidate) => candidate.assetId === asset.assetId).toSorted((left, right) => right.revision - left.revision)[0];
    const mayTrust = !asset.trusted && latest?.id === asset.id;
    const mayEdit = latest?.id === asset.id;
    return <article className={`library-card${editingAsset?.id === asset.id ? " editing" : ""}`} key={asset.id}><div><strong>{asset.name}</strong><small>{asset.tags.join(" · ") || "implementation"} · revision {asset.revision}</small></div><div className="library-actions"><span className={`pill ${asset.trusted ? "pill-safe" : ""}`}>{asset.trusted ? "enabled" : "disabled"}</span>{mayEdit && <Button variant="ghost" onClick={() => beginEdit(asset)} title="Edit implementation as a new revision" aria-label={`Edit ${asset.name} implementation`}><Pencil size={13} /></Button>}<Button variant="ghost" className="delete-icon-button" onClick={() => void deleteImplementation.request(asset)} title={`Delete ${asset.name} revision ${asset.revision}`} aria-label={`Delete ${asset.name} implementation revision ${asset.revision}`} disabled={deleteImplementation.isPending && deleteImplementation.variables?.id === asset.id}><Trash2 size={13} /></Button></div><code>{asset.contentHash.slice(0, 16)}…</code>{mayTrust && <Button variant="danger" className="trust-action" onClick={() => void requestTrust(asset)} disabled={trust.isPending}><ShieldCheck size={12} /> Trust as new revision</Button>}</article>;
  })}{trust.error && <div className="form-error implementation-error">{trust.error.message}</div>}{deleteImplementation.error && <div className="form-error implementation-error">{deleteImplementation.error.message}</div>}</div><form onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    {editingAsset && <div className="editor-context"><span>Edit implementation · revision {editingAsset.revision}</span><Button type="button" variant="ghost" onClick={() => { save.reset(); resetFields(); }} aria-label="Cancel implementation editing"><X size={13} /> Cancel</Button></div>}
    <div className="two-fields"><Field label="Label"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Mode"><Select value={mode} onChange={(event) => setMode(event.target.value as "real" | "mock")}><option value="real">Real command handler</option><option value="mock">Deterministic mock</option></Select></Field></div>
    {mode === "real" ? <Field label="Synchronous QuickJS source" hint="Expose build(input) and formatResult(result). No imports, filesystem, network, process, or environment access."><CodeMirror value={source} onChange={setSource} height="260px" theme="dark" /></Field> : <Field label="Mock JSON result"><CodeMirror value={mockResult} onChange={setMockResult} extensions={[json()]} height="160px" theme="dark" /></Field>}
    {editingAsset && <p className="warning provider-revision-note">Saving creates revision {editingAsset.revision + 1}. Existing session bindings remain pinned to revision {editingAsset.revision}.</p>}
    {save.error && <div className="form-error">{save.error.message}</div>}<Button disabled={!name || save.isPending}>{save.isPending ? "Saving…" : editingAsset ? "Save new revision" : "Save implementation revision"}</Button>
  </form></div></section>;
}

function ConnectionSettings({ section }: { section: "targets" | "mcp" }) {
  const dialogs = useOperatorDialog();
  const queryClient = useQueryClient();
  const targets = useQuery({ queryKey: ["assets", "target"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=target") });
  const servers = useQuery({ queryKey: ["assets", "mcp-server"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=mcp-server"), enabled: section === "mcp" });
  const secrets = useQuery({ queryKey: ["secrets"], queryFn: () => api<{ secrets: SecretMetadata[] }>("/api/secrets"), enabled: section === "mcp" });
  const defaultTargetJson = '{\n  "id": "container",\n  "label": "Existing container",\n  "kind": "container",\n  "runtime": "docker",\n  "container": "container-name"\n}';
  const [secretLabel, setSecretLabel] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [editingTarget, setEditingTarget] = useState<AssetRevision | null>(null);
  const [targetName, setTargetName] = useState("");
  const [targetJson, setTargetJson] = useState(defaultTargetJson);
  const [editingMcp, setEditingMcp] = useState<AssetRevision | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [mcpKind, setMcpKind] = useState<"stdio" | "streamableHttp">("stdio");
  const [mcpAddress, setMcpAddress] = useState("");
  const [mcpTargetId, setMcpTargetId] = useState("");
  const [mcpRoots, setMcpRoots] = useState("[]");
  const [mcpJson, setMcpJson] = useState("{}");
  const [secretId, setSecretId] = useState("");
  const deleteConnection = useConfirmedDelete({
    subject: section === "targets" ? "target revision" : "MCP profile",
    endpoint: (item) => `/api/library/assets/${item.id}`,
    invalidateKey: ["assets"],
    description: "This removes the revision from the global library. Lathe will refuse the deletion while another saved revision, harness, session, snapshot, project, or automation plan references it.",
    onDeleted: (item) => {
      if (editingTarget?.id === item.id) { setEditingTarget(null); setTargetName(""); setTargetJson(defaultTargetJson); }
      if (editingMcp?.id === item.id) { setEditingMcp(null); setMcpName(""); setMcpJson("{}"); }
    }
  });
  const deleteSecret = useConfirmedDelete({
    subject: "secret",
    endpoint: (item) => `/api/secrets/${item.id}`,
    invalidateKey: ["secrets"],
    description: "This permanently deletes the stored secret value. Lathe will refuse the deletion while an MCP profile, target, session, snapshot, or automation plan references its secret ID.",
    onDeleted: (item) => { if (secretId === item.id) setSecretId(""); }
  });
  const createSecret = useMutation({ mutationFn: () => api("/api/secrets", { method: "POST", ...jsonBody({ label: secretLabel, value: secretValue }) }), onSuccess: () => { setSecretLabel(""); setSecretValue(""); void queryClient.invalidateQueries({ queryKey: ["secrets"] }); } });
  const saveTarget = useMutation({ mutationFn: () => {
    const value = parseObjectJson(targetJson, "Target JSON");
    return api("/api/library/assets", { method: "POST", ...jsonBody({
      ...(editingTarget ? { assetId: editingTarget.assetId, baseRevisionId: editingTarget.id } : {}),
      kind: "target", name: targetName,
      description: editingTarget?.description ?? "Operator-authored execution target",
      tags: editingTarget?.tags ?? [],
      provenance: editingTarget
        ? { ...editingTarget.provenance, operatorAuthored: true, editedFromRevisionId: editingTarget.id, operatorEditedAt: new Date().toISOString() }
        : { operatorAuthored: true },
      trusted: editingTarget?.trusted ?? true,
      value
    }) });
  }, onSuccess: () => {
    setEditingTarget(null); setTargetName(""); setTargetJson(defaultTargetJson);
    void queryClient.invalidateQueries({ queryKey: ["assets", "target"] });
  } });
  const saveMcp = useMutation({ mutationFn: () => {
    if (editingMcp) {
      const value = parseObjectJson(mcpJson, "MCP profile JSON");
      return api("/api/library/assets", { method: "POST", ...jsonBody({
        assetId: editingMcp.assetId,
        baseRevisionId: editingMcp.id,
        kind: "mcp-server",
        name: mcpName,
        description: editingMcp.description,
        tags: editingMcp.tags,
        provenance: { ...editingMcp.provenance, operatorAuthored: true, editedFromRevisionId: editingMcp.id, operatorEditedAt: new Date().toISOString() },
        trusted: editingMcp.trusted,
        value: { ...value, name: mcpName, revision: String(editingMcp.revision + 1) }
      }) });
    }
    const id = crypto.randomUUID();
    const transport = mcpKind === "stdio"
      ? { kind: "stdio", command: mcpAddress, args: [], ...(mcpTargetId ? { executionTargetId: mcpTargetId } : {}), ...(secretId ? { env: { LATHE_MCP_TOKEN: { kind: "secret", secretId } } } : {}) }
      : { kind: "streamableHttp", url: mcpAddress, ...(secretId ? { headers: { Authorization: { kind: "secret", secretId, prefix: "Bearer " } } } : {}) };
    return api("/api/library/assets", { method: "POST", ...jsonBody({ kind: "mcp-server", name: mcpName, description: "Operator-authored MCP server", tags: [mcpKind], provenance: { operatorAuthored: true }, trusted: true, value: { id, revision: "1", name: mcpName, transport, roots: JSON.parse(mcpRoots) } }) });
  }, onSuccess: () => {
    setEditingMcp(null); setMcpName(""); setMcpAddress(""); setMcpTargetId(""); setMcpRoots("[]"); setMcpJson("{}"); setSecretId("");
    void queryClient.invalidateQueries({ queryKey: ["assets", "mcp-server"] });
  } });
  const inspectMcp = useMutation({ mutationFn: (revisionId: string) => api<{ snapshot: unknown; traceHash: string }>(`/api/mcp/${revisionId}/capabilities`, { method: "POST" }) });
  const trustConnection = useMutation({
    mutationFn: (asset: AssetRevision) => {
      if (asset.kind !== "target" && asset.kind !== "mcp-server") throw new Error("Only target and MCP server revisions can be trusted here");
      return api("/api/library/assets", { method: "POST", ...jsonBody({
        assetId: asset.assetId,
        kind: asset.kind,
        name: asset.name,
        description: asset.description,
        tags: asset.tags,
        provenance: { ...asset.provenance, trustedFromRevisionId: asset.id, operatorTrustedAt: new Date().toISOString() },
        value: asset.value,
        trusted: true
      }) });
    },
    onSuccess: (_result, asset) => void queryClient.invalidateQueries({ queryKey: ["assets", asset.kind] })
  });
  const beginTargetEdit = (asset: AssetRevision) => {
    saveTarget.reset();
    setEditingTarget(asset);
    setTargetName(asset.name);
    setTargetJson(JSON.stringify(asset.value, null, 2));
  };
  const cancelTargetEdit = () => {
    saveTarget.reset();
    setEditingTarget(null);
    setTargetName("");
    setTargetJson(defaultTargetJson);
  };
  const beginMcpEdit = (asset: AssetRevision) => {
    saveMcp.reset();
    setEditingMcp(asset);
    setMcpName(asset.name);
    setMcpJson(JSON.stringify(asset.value, null, 2));
  };
  const cancelMcpEdit = () => {
    saveMcp.reset();
    setEditingMcp(null);
    setMcpName("");
    setMcpJson("{}");
  };
  const requestTrustConnection = async (asset: AssetRevision) => {
    const target = asset.kind === "target";
    const approved = await dialogs.confirm({
      title: `Trust ${asset.name}?`,
      description: target
        ? "This creates a trusted target revision that may launch host, container, or SSH commands under the session's approval policy."
        : "This creates a trusted MCP profile revision. Connecting may contact a server or launch its configured stdio command.",
      confirmLabel: "Trust new revision",
      danger: true
    });
    if (approved) trustConnection.mutate(asset);
  };
  return <><div className="connection-grid connection-grid-single">
    {section === "targets" && <section className="panel"><div className="panel-title"><Box size={16} /> Execution targets</div><p className="quiet">Host execution is built in. Container and SSH targets are versioned global assets and require approval by default unless a session explicitly selects bypass approval.</p>
      {targets.data?.assets.map((asset) => {
        const latest = targets.data.assets.filter((candidate) => candidate.assetId === asset.assetId).toSorted((left, right) => right.revision - left.revision)[0];
        const mayTrust = !asset.trusted && latest?.id === asset.id;
        const mayEdit = latest?.id === asset.id;
        return <article className={`library-card${editingTarget?.id === asset.id ? " editing" : ""}`} key={asset.id}><div><strong>{asset.name}</strong><small>revision {asset.revision}</small></div><div className="library-actions"><span className={`pill ${asset.trusted ? "pill-safe" : ""}`}>{asset.trusted ? "enabled" : "disabled"}</span>{mayEdit && <Button variant="ghost" onClick={() => beginTargetEdit(asset)} title="Edit target as a new revision" aria-label={`Edit ${asset.name} target`}><Pencil size={13} /></Button>}<Button variant="ghost" className="delete-icon-button" onClick={() => void deleteConnection.request(asset)} title={`Delete ${asset.name} revision ${asset.revision}`} aria-label={`Delete ${asset.name} target revision ${asset.revision}`} disabled={deleteConnection.isPending && deleteConnection.variables?.id === asset.id}><Trash2 size={13} /></Button></div><code>{JSON.stringify(asset.value)}</code>{mayTrust && <Button variant="danger" className="trust-action" onClick={() => void requestTrustConnection(asset)} disabled={trustConnection.isPending}><ShieldCheck size={12} /> Trust as new revision</Button>}</article>;
      })}{deleteConnection.error && <div className="form-error library-delete-error">{deleteConnection.error.message}</div>}<form className="connection-form" onSubmit={(event) => { event.preventDefault(); saveTarget.mutate(); }}>{editingTarget && <div className="editor-context"><span>Edit target · revision {editingTarget.revision}</span><Button type="button" variant="ghost" onClick={cancelTargetEdit} aria-label="Cancel target editing"><X size={13} /> Cancel</Button></div>}<Field label="Target label"><Input value={targetName} onChange={(event) => setTargetName(event.target.value)} required /></Field><Field label="Target JSON" hint={editingTarget ? "Redacted environment values are preserved. Replace a marker to update it, or delete the key to remove it." : undefined}><CodeMirror value={targetJson} onChange={setTargetJson} extensions={[json()]} height="175px" theme="dark" /></Field>{editingTarget && <p className="warning provider-revision-note">Saving creates revision {editingTarget.revision + 1}. Existing session bindings remain pinned to revision {editingTarget.revision}.</p>}{saveTarget.error && <div className="form-error">{saveTarget.error.message}</div>}<Button disabled={!targetName || saveTarget.isPending}>{saveTarget.isPending ? "Saving…" : editingTarget ? "Save new revision" : "Save target"}</Button></form></section>}
    {section === "mcp" && <section className="panel"><div className="panel-title"><Cable size={16} /> MCP servers</div><p className="quiet">Stdio and Streamable HTTP are supported. A stdio profile may launch through any trusted execution-target revision.</p>
      {servers.data?.assets.map((asset) => {
        const latest = servers.data.assets.filter((candidate) => candidate.assetId === asset.assetId).toSorted((left, right) => right.revision - left.revision)[0];
        const mayTrust = !asset.trusted && latest?.id === asset.id;
        const mayEdit = latest?.id === asset.id;
        return <article className={`library-card${editingMcp?.id === asset.id ? " editing" : ""}`} key={asset.id}><div><strong>{asset.name}</strong><small>{asset.tags.join(" · ")} · revision {asset.revision}</small></div><div className="library-actions"><span className={`pill ${asset.trusted ? "pill-safe" : ""}`}>{asset.trusted ? "enabled" : "disabled"}</span><Button variant="ghost" onClick={() => inspectMcp.mutate(asset.id)} title="Inspect capabilities" aria-label={`Inspect ${asset.name} capabilities`} disabled={!asset.trusted}><Cable size={13} /></Button>{mayEdit && <Button variant="ghost" onClick={() => beginMcpEdit(asset)} title="Edit MCP profile as a new revision" aria-label={`Edit ${asset.name} MCP profile`}><Pencil size={13} /></Button>}<Button variant="ghost" className="delete-icon-button" onClick={() => void deleteConnection.request(asset)} title={`Delete ${asset.name} revision ${asset.revision}`} aria-label={`Delete ${asset.name} MCP profile revision ${asset.revision}`} disabled={deleteConnection.isPending && deleteConnection.variables?.id === asset.id}><Trash2 size={13} /></Button></div><code>{asset.contentHash.slice(0, 16)}…</code>{mayTrust && <Button variant="danger" className="trust-action" onClick={() => void requestTrustConnection(asset)} disabled={trustConnection.isPending}><ShieldCheck size={12} /> Trust as new revision</Button>}</article>;
      })}<form className="connection-form" onSubmit={(event) => { event.preventDefault(); saveMcp.mutate(); }}>{editingMcp && <div className="editor-context"><span>Edit MCP profile · revision {editingMcp.revision}</span><Button type="button" variant="ghost" onClick={cancelMcpEdit} aria-label="Cancel MCP profile editing"><X size={13} /> Cancel</Button></div>}{editingMcp ? <><Field label="Server label"><Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} required /></Field><Field label="Profile JSON" hint="Secret references remain symbolic. Saving updates the embedded profile revision automatically."><CodeMirror value={mcpJson} onChange={setMcpJson} extensions={[json()]} height="260px" theme="dark" /></Field><p className="warning provider-revision-note">Saving creates revision {editingMcp.revision + 1}. Existing session bindings remain pinned to revision {editingMcp.revision}.</p></> : <><div className="two-fields"><Field label="Server label"><Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} required /></Field><Field label="Transport"><Select value={mcpKind} onChange={(event) => setMcpKind(event.target.value as typeof mcpKind)}><option value="stdio">stdio</option><option value="streamableHttp">Streamable HTTP</option></Select></Field></div><Field label={mcpKind === "stdio" ? "Command" : "URL"}><Input value={mcpAddress} onChange={(event) => setMcpAddress(event.target.value)} required /></Field>{mcpKind === "stdio" && <Field label="Execution target" hint="Host is the default. Select a trusted revision to launch stdio through Docker, Podman, or SSH."><Select value={mcpTargetId} onChange={(event) => setMcpTargetId(event.target.value)}><option value="">Host process</option>{targets.data?.assets.filter((asset) => asset.trusted).map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select></Field>}<Field label="Optional credential"><Select value={secretId} onChange={(event) => setSecretId(event.target.value)}><option value="">None</option>{secrets.data?.secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.label}</option>)}</Select></Field><Field label="Roots (JSON array)" hint="Roots default to none. Adding one explicitly exposes that URI and its contents to the MCP server."><CodeMirror value={mcpRoots} onChange={setMcpRoots} extensions={[json()]} height="85px" theme="dark" /></Field></>}{saveMcp.error && <div className="form-error">{saveMcp.error.message}</div>}<Button disabled={!mcpName || (!editingMcp && !mcpAddress) || saveMcp.isPending}>{saveMcp.isPending ? "Saving…" : editingMcp ? "Save new revision" : "Save MCP profile"}</Button></form>{trustConnection.error && <div className="form-error">{trustConnection.error.message}</div>}{inspectMcp.error && <div className="form-error">{inspectMcp.error.message}</div>}{inspectMcp.data && <pre className="capability-result">{JSON.stringify(inspectMcp.data, null, 2)}</pre>}</section>}
  </div>{section === "mcp" && <section className="panel secret-panel"><div className="panel-title"><KeyRound size={16} /> Secret references</div><p className="quiet">Values are stored plaintext in v1 but are never returned after saving. MCP profiles reference only secret IDs.</p><div className="secret-list">{secrets.data?.secrets.map((secret) => <span className="secret-entry" key={secret.id}><span className="pill">{secret.label}</span><Button variant="ghost" className="delete-icon-button" onClick={() => void deleteSecret.request({ id: secret.id, name: secret.label })} title={`Delete ${secret.label}`} aria-label={`Delete ${secret.label} secret`} disabled={deleteSecret.isPending && deleteSecret.variables?.id === secret.id}><Trash2 size={12} /></Button></span>)}</div>{deleteSecret.error && <div className="form-error library-delete-error">{deleteSecret.error.message}</div>}<form className="connection-form inline-secret" onSubmit={(event) => { event.preventDefault(); createSecret.mutate(); }}><Field label="Label"><Input value={secretLabel} onChange={(event) => setSecretLabel(event.target.value)} required /></Field><Field label="Value"><Input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} required autoComplete="off" /></Field><Button disabled={!secretLabel || !secretValue}>Store secret</Button></form></section>}</>;
}

interface ArtifactImportResult {
  manifest: { artifactId: string; kind: "harness" | "finding"; generator: { name: "lathe"; version: string } };
  importedAsset?: AssetRevision;
  project?: { id: string; name: string };
  session?: { id: string; projectId: string };
  scriptsEnabled: boolean;
}

function ArtifactSettings() {
  const queryClient = useQueryClient();
  const harnesses = useQuery({ queryKey: ["assets", "harness"], queryFn: () => api<{ assets: AssetRevision[] }>("/api/assets?kind=harness") });
  const [file, setFile] = useState<File | null>(null);
  const deleteHarness = useConfirmedDelete({
    subject: "harness revision",
    endpoint: (item) => `/api/library/assets/${item.id}`,
    invalidateKey: ["assets", "harness"],
    description: "This removes the harness revision from the global library. Lathe will refuse the deletion while it is a project default, session draft dependency, saved snapshot dependency, or automation input.",
  });
  const importBundle = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Select a Lathe artifact bundle");
      const form = new FormData();
      form.set("file", file);
      return api<ArtifactImportResult>("/api/artifacts/import", { method: "POST", body: form });
    },
    onSuccess: () => {
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["assets", "harness"] });
    }
  });
  const exportHarness = useMutation({
    mutationFn: (harness: AssetRevision) => downloadApiFile(`/api/harnesses/${harness.id}/export`, `${harness.name}.lathe-harness`)
  });
  return <div className="artifact-grid">
    <section className="panel library-list"><div className="panel-title"><Download size={16} /> Export reusable harnesses <small>{harnesses.data?.assets.length ?? 0}</small></div>
      <p className="quiet artifact-intro">Bundles include the versioned harness, referenced prompt/tool specifications, a manifest, and SHA-256 checksums. Credentials are never exported.</p>
      {harnesses.data?.assets.map((harness) => <article className="library-card artifact-card" key={harness.id}><div><strong>{harness.name}</strong><small>revision {harness.revision} · {harness.trusted ? "trusted" : "disabled"}</small></div><div className="library-actions"><Button variant="ghost" onClick={() => exportHarness.mutate(harness)} title="Export harness bundle" aria-label={`Export ${harness.name} harness`}><Download size={14} /></Button><Button variant="ghost" className="delete-icon-button" onClick={() => void deleteHarness.request(harness)} title={`Delete ${harness.name} revision ${harness.revision}`} aria-label={`Delete ${harness.name} harness revision ${harness.revision}`} disabled={deleteHarness.isPending && deleteHarness.variables?.id === harness.id}><Trash2 size={13} /></Button></div><p>{harness.description || "No description"}</p><code>{harness.contentHash.slice(0, 16)}…</code></article>)}
      {harnesses.data?.assets.length === 0 && <p className="quiet">No harness revisions available.</p>}
      {exportHarness.error && <div className="form-error artifact-error">{exportHarness.error.message}</div>}
      {deleteHarness.error && <div className="form-error artifact-error">{deleteHarness.error.message}</div>}
    </section>
    <section className="panel artifact-import-panel"><div className="panel-title"><Upload size={16} /> Import an artifact</div>
      <form onSubmit={(event) => { event.preventDefault(); importBundle.mutate(); }}>
        <div className="artifact-drop"><PackageOpen size={28} /><strong>{file?.name ?? "Choose a Lathe bundle"}</strong><small>.lathe-harness, .lathe-finding, or ZIP</small><Input type="file" accept=".lathe-harness,.lathe-finding,.zip,application/zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></div>
        <p className="warning">Archives are checked for path traversal, malformed schemas, invalid hashes, and expansion limits. Imported scripts remain disabled until explicitly trusted.</p>
        {importBundle.error && <div className="form-error">{importBundle.error.message}</div>}
        <Button disabled={!file || importBundle.isPending}>{importBundle.isPending ? "Verifying bundle…" : "Verify and import"}</Button>
      </form>
      {importBundle.data && <div className="import-result"><span className="pill pill-safe">Imported</span><h3>{importBundle.data.manifest.kind === "harness" ? importBundle.data.importedAsset?.name : importBundle.data.project?.name}</h3><code>{importBundle.data.manifest.artifactId}</code><p>Generated by {importBundle.data.manifest.generator.name} v{importBundle.data.manifest.generator.version} · scripts {importBundle.data.scriptsEnabled ? "enabled" : "disabled"}</p>{importBundle.data.session && <a href={`/projects/${importBundle.data.session.projectId}/sessions/${importBundle.data.session.id}`}>Open imported evidence →</a>}</div>}
    </section>
  </div>;
}
