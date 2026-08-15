import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { ArrowDown, ArrowUp, Braces, CaseSensitive, Check, ChevronDown, CircleStop, Code2, Download, Eye, FileClock, GitCompare, History, ListRestart, Play, Plus, RefreshCw, RotateCcw, Send, Sparkles, Trash2, Undo2, WandSparkles, X } from "lucide-react";
import type { JsonObject, JsonValue, MessageNode } from "@lathe/domain";
import { applyPayloadTransform, evaluatePayloadPipeline, payloadTransforms, techniqueSelectionWarnings, type PayloadPipelineStep, type PayloadTechnique, type PayloadTransformDefinition, type PayloadTransformId } from "@lathe/payloads";
import { api, consumeEvents, downloadApiFile, jsonBody } from "../api.js";
import {
  candidatesFromDetail,
  defaultPayloadWorkbenchSettings,
  normalizePayloadContextPreview,
  normalizePayloadWorkbenchSettings,
  payloadContextRequestOptions,
  reducePayloadGenerationEvent,
  type PayloadAssetKind,
  type PayloadAssetRevision,
  type PayloadContextPreview,
  type PayloadGeneration,
  type PayloadGenerationDetail,
  type PayloadGenerationEvent,
  type PayloadGenerationList,
  type PayloadRevision,
  type PayloadOutcome,
  type PayloadWorkbenchSettings,
  type StreamingPayloadCandidate
} from "../payload-workbench-api.js";
import { Button, Field, Input, Select, Textarea } from "./forms.js";
import { useOperatorDialog } from "./operator-dialog.js";

export { applyPayloadTransform, type PayloadTransformId } from "@lathe/payloads";

export const payloadTransformGroups: Array<{ label: string; icon: "code" | "case" | "frame"; transforms: PayloadTransformDefinition[] }> = [
  { label: "Encoding", icon: "code", transforms: payloadTransforms.filter((transform) => transform.group === "encoding") },
  { label: "Transform", icon: "case", transforms: payloadTransforms.filter((transform) => transform.group === "text") },
  { label: "Red-team framing", icon: "frame", transforms: payloadTransforms.filter((transform) => transform.group === "framing") },
  { label: "Variables", icon: "code", transforms: payloadTransforms.filter((transform) => transform.group === "variables") }
];

type WorkbenchTab = "transform" | "generate" | "history";

export interface PayloadWorkbenchContext {
  projectId: string;
  sessionId: string;
  sessionName: string;
  sessionDescription?: string;
  targetName?: string;
  branchId: string;
  branchName: string;
  contextNodeId: string | null;
  path: MessageNode[];
}

export interface PayloadWorkbenchSelection {
  text: string;
  sourcePayloadRevisionId: string | null;
}

interface VariableOverride {
  id: number;
  name: string;
  value: string;
}

interface GenerationResponse {
  generation: PayloadGeneration;
  attempts?: PayloadGenerationDetail["attempts"];
  revisions?: PayloadGenerationDetail["revisions"];
  outcomes?: PayloadOutcome[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonRecord(value: JsonValue): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function orderedRevisions(assets: PayloadAssetRevision[]): PayloadAssetRevision[] {
  return [...assets].toSorted((left, right) => left.name.localeCompare(right.name) || right.revision - left.revision);
}

function responseDetail(response: GenerationResponse): PayloadGenerationDetail {
  return { generation: response.generation, attempts: response.attempts ?? [], revisions: response.revisions ?? [], ...(Array.isArray(response.outcomes) ? { outcomes: response.outcomes } : {}) };
}

function mergePersistedCandidates(current: StreamingPayloadCandidate[], persisted: StreamingPayloadCandidate[]): StreamingPayloadCandidate[] {
  const merged = persisted.map((candidate) => {
    const live = current.find((item) => item.attemptId === candidate.attemptId || item.ordinal === candidate.ordinal);
    if (!live || !["queued", "streaming"].includes(candidate.status)) return candidate;
    return {
      ...candidate,
      text: live.text.length > candidate.text.length ? live.text : candidate.text,
      reasoning: live.reasoning.length > candidate.reasoning.length ? live.reasoning : candidate.reasoning,
      error: candidate.error ?? live.error
    };
  });
  for (const live of current) {
    if (!merged.some((candidate) => candidate.attemptId === live.attemptId || candidate.ordinal === live.ordinal)) merged.push(live);
  }
  return merged.toSorted((left, right) => left.ordinal - right.ordinal);
}

function eventEnvelope(value: unknown): PayloadGenerationEvent | null {
  const source = record(value);
  if (typeof source.type !== "string" || !("data" in source)) return null;
  return { type: source.type, data: source.data as JsonValue };
}

function variablesObject(rows: VariableOverride[]): JsonObject {
  return Object.fromEntries(rows.flatMap((row) => row.name.trim() ? [[row.name.trim(), row.value]] : []));
}

function variablesAsStrings(rows: VariableOverride[]): Record<string, string> {
  return Object.fromEntries(rows.flatMap((row) => row.name.trim() ? [[row.name.trim(), row.value]] : []));
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function uniqueOutcomes(items: PayloadOutcome[]): PayloadOutcome[] {
  return [...new Map(items.map((item) => [`${item.revisionId}:${item.runId}`, item])).values()];
}

function variableRows(value: JsonObject | undefined): VariableOverride[] {
  return Object.entries(value ?? {}).map(([name, item], index) => ({ id: index + 1, name, value: typeof item === "string" ? item : JSON.stringify(item) }));
}

function TransformGroupIcon({ icon }: { icon: "code" | "case" | "frame" }) {
  if (icon === "code") return <Code2 size={14} />;
  if (icon === "case") return <CaseSensitive size={15} />;
  return <Braces size={14} />;
}

function usePayloadAssets(kind: PayloadAssetKind, enabled: boolean) {
  return useQuery({ queryKey: ["assets", kind], queryFn: () => api<{ assets: PayloadAssetRevision[] }>(`/api/assets?kind=${encodeURIComponent(kind)}`), enabled });
}

function VariableOverridesEditor({ rows, onChange }: { rows: VariableOverride[]; onChange(rows: VariableOverride[]): void }) {
  return <fieldset className="payload-variable-editor"><legend>Variable overrides</legend>
    {rows.map((row) => <div key={row.id}><Input aria-label={`Variable ${row.id} name`} value={row.name} onChange={(event) => onChange(rows.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} placeholder="name" /><Input aria-label={`Variable ${row.name || row.id} value`} value={row.value} onChange={(event) => onChange(rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} placeholder="exact value" /><Button type="button" variant="ghost" aria-label={`Remove variable ${row.name || row.id}`} onClick={() => onChange(rows.filter((item) => item.id !== row.id))}><X size={12} /></Button></div>)}
    <Button type="button" variant="secondary" onClick={() => onChange([...rows, { id: Math.max(0, ...rows.map((row) => row.id)) + 1, name: "", value: "" }])}><Plus size={12} /> Add variable</Button>
  </fieldset>;
}

function ContextControls({ value, onChange, onPreview, preview, pending, error, context }: {
  value: PayloadWorkbenchSettings;
  onChange(value: PayloadWorkbenchSettings): void;
  onPreview(): void;
  preview: PayloadContextPreview | null;
  pending: boolean;
  error: string | undefined;
  context: PayloadWorkbenchContext;
}) {
  const changeMode = (contextMode: PayloadWorkbenchSettings["contextMode"]) => onChange({
    ...value,
    contextMode,
    ...(contextMode === "minimal" ? { includeTargetConfig: false } : contextMode === "full" ? { includeTargetConfig: true } : {})
  });
  const approximateTokens = Math.ceil(value.budgetChars / 4);
  return <section className="payload-context-panel">
    <div className="payload-context-heading"><div><strong>Generation context</strong><small>{context.branchName} · head {context.contextNodeId?.slice(0, 8) ?? "root"} · {context.path.length} messages</small></div><Button type="button" variant="secondary" onClick={onPreview} disabled={pending}>{pending ? <span className="spinner small" /> : <Eye size={13} />} Preview</Button></div>
    <Field label="Conversation"><Select value={value.contextMode} onChange={(event) => changeMode(event.target.value as PayloadWorkbenchSettings["contextMode"])}><option value="none">None</option><option value="minimal">Minimal</option><option value="full">Full active path</option></Select></Field>
    <Field label="Context budget" hint={`${value.budgetChars.toLocaleString()} characters · approximately ${approximateTokens.toLocaleString()} tokens`}><div className="payload-budget-control"><input aria-label="Context budget slider" type="range" min="2000" max="200000" step="1000" value={value.budgetChars} onChange={(event) => onChange({ ...value, budgetChars: Number(event.target.value) })} /><Input aria-label="Exact context budget" type="number" min="2000" max="200000" step="1000" value={value.budgetChars} onChange={(event) => onChange({ ...value, budgetChars: Number(event.target.value) })} /></div></Field>
    <div className="payload-context-toggles"><label><input type="checkbox" checked={value.includeProjectBrief} onChange={(event) => onChange({ ...value, includeProjectBrief: event.target.checked })} />Project brief</label><label><input type="checkbox" checked={value.includeSessionBrief} onChange={(event) => onChange({ ...value, includeSessionBrief: event.target.checked })} />Session brief</label><label><input type="checkbox" checked={value.includeTargetConfig} onChange={(event) => onChange({ ...value, includeTargetConfig: event.target.checked })} />Target config</label></div>
    {preview && <details className={`payload-context-preview${preview.fits ? "" : " over-budget"}`} open><summary>{preview.includedChars.toLocaleString()} characters{preview.truncated ? " · truncated" : ""}{preview.fits ? " · fits budget" : ` · requires at least ${(preview.requiredMinimumChars ?? preview.includedChars).toLocaleString()}`}</summary><pre>{preview.text || JSON.stringify(preview.snapshot ?? {}, null, 2)}</pre>{preview.warnings.map((warning) => <p className="warning" key={warning}>{warning}</p>)}</details>}
    {error && <div className="form-error">{error}</div>}
  </section>;
}

function OrderedTechniques({ assets, selected, onChange }: { assets: PayloadAssetRevision[]; selected: string[]; onChange(ids: string[]): void }) {
  const selectedAssets = selected.flatMap((id) => assets.find((asset) => asset.id === id) ?? []);
  const unselected = assets.filter((asset) => !selected.includes(asset.id));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= selected.length) return;
    const next = [...selected]; [next[index], next[target]] = [next[target]!, next[index]!]; onChange(next);
  };
  return <fieldset className="payload-technique-order"><legend>Ordered techniques</legend>
    {selectedAssets.map((asset, index) => <div key={asset.id}><span>{index + 1}</span><strong>{asset.name}</strong><Button type="button" variant="ghost" disabled={index === 0} aria-label={`Move ${asset.name} up`} onClick={() => move(index, -1)}><ArrowUp size={12} /></Button><Button type="button" variant="ghost" disabled={index === selectedAssets.length - 1} aria-label={`Move ${asset.name} down`} onClick={() => move(index, 1)}><ArrowDown size={12} /></Button><Button type="button" variant="ghost" aria-label={`Remove ${asset.name}`} onClick={() => onChange(selected.filter((id) => id !== asset.id))}><X size={12} /></Button></div>)}
    {unselected.length > 0 && <Select aria-label="Add technique" value="" onChange={(event) => { if (event.target.value) onChange([...selected, event.target.value]); }}><option value="">Add technique…</option>{unselected.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</Select>}
    {assets.length === 0 && <p>No saved techniques. Add them from the global Payload Workbench settings.</p>}
  </fieldset>;
}

function RawPayloadDiff({ original, candidates, selectedIds, onClose }: { original: string; candidates: StreamingPayloadCandidate[]; selectedIds: string[]; onClose(): void }) {
  const [mode, setMode] = useState<"raw" | "rendered">("raw");
  const selected = selectedIds.flatMap((id) => candidates.find((candidate) => candidate.attemptId === id) ?? []);
  const left = selected.length > 1 ? selected[0]?.text ?? original : original;
  const right = selected.at(-1)?.text ?? "";
  const leftLabel = selected.length > 1 ? `Candidate ${selected[0]?.ordinal ?? 1}` : "Source payload";
  const rightLabel = selected.length ? `Candidate ${selected.at(-1)?.ordinal ?? 1}` : "Candidate";
  return <section className="payload-raw-diff" aria-label="Payload comparison"><header><div><GitCompare size={14} /><strong>Side-by-side comparison</strong><span>Raw is authoritative</span></div><div className="payload-diff-mode"><button type="button" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw</button><button type="button" aria-pressed={mode === "rendered"} onClick={() => setMode("rendered")}>Rendered Markdown</button><Button type="button" variant="ghost" aria-label="Close payload diff" onClick={onClose}><X size={13} /></Button></div></header><div><article><h4>{leftLabel}</h4>{mode === "raw" ? <pre>{left}</pre> : <div className="payload-diff-rendered"><ReactMarkdown rehypePlugins={[rehypeSanitize]}>{left}</ReactMarkdown></div>}</article><article><h4>{rightLabel}</h4>{mode === "raw" ? <pre>{right}</pre> : <div className="payload-diff-rendered"><ReactMarkdown rehypePlugins={[rehypeSanitize]}>{right}</ReactMarkdown></div>}</article></div></section>;
}

function CandidateCard({ candidate, revision, selectedForDiff, onToggleDiff, onRefine, onTransform, onUse, refining }: {
  candidate: StreamingPayloadCandidate;
  revision?: PayloadRevision;
  selectedForDiff: boolean;
  onToggleDiff(): void;
  onRefine(feedback: string): void;
  onTransform(): void;
  onUse(): void;
  refining: boolean;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const partial = candidate.status === "partial" || (["failed", "cancelled", "interrupted"].includes(candidate.status) && candidate.text.length > 0);
  const canUsePersistedCandidate = Boolean(revision) && ["partial", "completed", "failed", "cancelled", "interrupted"].includes(candidate.status) && candidate.text.length > 0;
  const evidence = candidate.evidence;
  const hasEvidence = Boolean(evidence && (evidence.providerProfileId || evidence.modelId || evidence.nativeThreadId || evidence.nativeTurnId || evidence.traceHash || evidence.backendSnapshot !== undefined || evidence.usage !== undefined || evidence.warnings.length > 0));
  return <article className={`payload-candidate-card status-${candidate.status}`}>
    <header><div><strong>Candidate {candidate.ordinal}</strong><span className={`status-badge status-${candidate.status}`}>{partial ? "partial" : candidate.status}</span>{candidate.classification && <span className="pill">{candidate.classification}</span>}</div><label title="Select up to two candidates for raw comparison"><input type="checkbox" checked={selectedForDiff} onChange={onToggleDiff} /> diff</label></header>
    {candidate.reasoning && <details className="payload-candidate-reasoning"><summary><ChevronDown size={12} /> Reasoning · {candidate.reasoning.length} chars</summary><pre>{candidate.reasoning}</pre></details>}
    <pre className="payload-candidate-text">{candidate.text || (candidate.status === "queued" ? "Waiting for output…" : "No candidate text was returned.")}</pre>
    {candidate.error && <div className="form-error">{candidate.error}</div>}
    {hasEvidence && evidence && <details className="payload-candidate-evidence"><summary>Backend evidence &amp; provenance</summary><dl>{evidence.providerProfileId && <><dt>Provider</dt><dd><code>{evidence.providerProfileId}</code></dd></>}{evidence.modelId && <><dt>Model</dt><dd><code>{evidence.modelId}</code></dd></>}{evidence.nativeThreadId && <><dt>Native thread</dt><dd><code>{evidence.nativeThreadId}</code></dd></>}{evidence.nativeTurnId && <><dt>Native turn</dt><dd><code>{evidence.nativeTurnId}</code></dd></>}{evidence.traceHash && <><dt>Trace</dt><dd><code>{evidence.traceHash}</code><Button type="button" variant="ghost" aria-label={`Download generator trace ${evidence.traceHash}`} title="Download and inspect the redacted NDJSON trace" onClick={() => void downloadApiFile(`/api/traces/${evidence.traceHash}`, `${evidence.traceHash}.ndjson`)}><Download size={12} /></Button></dd></>}</dl>{evidence.warnings.length > 0 && <div className="payload-candidate-warnings"><strong>Warnings</strong>{evidence.warnings.map((warning, index) => <p key={`${warning}:${index}`}>{warning}</p>)}</div>}{evidence.backendSnapshot !== undefined && <details><summary>Backend snapshot</summary><pre>{JSON.stringify(evidence.backendSnapshot, null, 2)}</pre></details>}{evidence.usage !== undefined && evidence.usage !== null && <details><summary>Usage</summary><pre>{JSON.stringify(evidence.usage, null, 2)}</pre></details>}</details>}
    <footer><span>{new TextEncoder().encode(candidate.text).byteLength.toLocaleString()} bytes</span><div><Button type="button" variant="ghost" title={canUsePersistedCandidate ? "Send this candidate to deterministic transforms" : "Wait for the persisted terminal candidate"} aria-label={`Send candidate ${candidate.ordinal} to Transform`} onClick={onTransform} disabled={!canUsePersistedCandidate}><Send size={13} /></Button><Button type="button" variant="secondary" onClick={() => setFeedbackOpen((value) => !value)} disabled={!canUsePersistedCandidate || refining}><RefreshCw size={13} /> Refine</Button><Button type="button" onClick={onUse} disabled={!canUsePersistedCandidate}><Check size={13} /> {partial ? "Use partial" : "Use"}</Button></div></footer>
    {feedbackOpen && <form className="payload-refine-form" onSubmit={(event) => { event.preventDefault(); if (feedback.trim()) onRefine(feedback.trim()); }}><Field label="Refinement feedback"><Textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} placeholder="Make it shorter, preserve the encoding layer, vary the authority framing…" required /></Field><Button disabled={!feedback.trim() || refining}>{refining ? "Starting…" : "Generate refinement"}</Button></form>}
  </article>;
}

function GenerationCandidates({ generation, candidates, revisions, original, diffIds, onDiffChange, onRefine, onTransform, onUse, refinePending }: {
  generation: PayloadGeneration | null;
  candidates: StreamingPayloadCandidate[];
  revisions: PayloadRevision[];
  original: string;
  diffIds: string[];
  onDiffChange(ids: string[]): void;
  onRefine(revision: PayloadRevision, feedback: string): void;
  onTransform(candidate: StreamingPayloadCandidate, revision?: PayloadRevision): void;
  onUse(candidate: StreamingPayloadCandidate, revision?: PayloadRevision): void;
  refinePending: boolean;
}) {
  if (!generation && candidates.length === 0) return <div className="payload-candidates-empty"><Sparkles size={24} /><h3>No candidates yet</h3><p>Describe the variation you want, preview the selected context, then generate one to four candidate payloads.</p></div>;
  return <div className="payload-candidate-results">
    <div className="payload-generation-state"><span className={`status-badge status-${generation?.status ?? "streaming"}`}>{generation?.status ?? "streaming"}</span><span>{candidates.length} candidate{candidates.length === 1 ? "" : "s"}</span>{generation?.id && <code>{generation.id.slice(0, 8)}</code>}</div>
    {diffIds.length > 0 && <RawPayloadDiff original={original} candidates={candidates} selectedIds={diffIds} onClose={() => onDiffChange([])} />}
    <div className="payload-candidate-grid">{candidates.map((candidate) => {
      const revision = candidate.revisionId ? revisions.find((item) => item.id === candidate.revisionId) : revisions.find((item) => item.attemptId === candidate.attemptId || item.sourceAttemptId === candidate.attemptId);
      return <CandidateCard key={candidate.attemptId} candidate={candidate} {...(revision ? { revision } : {})} selectedForDiff={diffIds.includes(candidate.attemptId)} onToggleDiff={() => onDiffChange(diffIds.includes(candidate.attemptId) ? diffIds.filter((id) => id !== candidate.attemptId) : [...diffIds.slice(-1), candidate.attemptId])} onRefine={(feedback) => { if (revision) onRefine(revision, feedback); }} onTransform={() => onTransform(candidate, revision)} onUse={() => onUse(candidate, revision)} refining={refinePending} />;
    })}</div>
  </div>;
}

function RevisionOutcomes({ outcomes, revisionId }: { outcomes: PayloadOutcome[]; revisionId: string }) {
  const exact = outcomes.filter((outcome) => outcome.revisionId === revisionId).toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (exact.length === 0) return null;
  return <div className="payload-history-outcomes">{exact.map((outcome) => <span key={outcome.runId} title={outcome.operatorNotes ?? outcome.classification ?? outcome.status}><b>{outcome.operatorLabel ?? outcome.classification ?? outcome.status}</b>{outcome.operatorNotes && <i>{outcome.operatorNotes}</i>}</span>)}</div>;
}

function HistoryPanel({ context, generations, standaloneRevisions, standaloneOutcomes, loading, loadingMore, hasMore, error, onLoadMore, onRestore, onRestoreRevision, onDelete, onDeleteRevision, restoringId, deletingId, deletingRevisionId }: {
  context?: PayloadWorkbenchContext;
  generations: PayloadGenerationDetail[];
  standaloneRevisions: PayloadRevision[];
  standaloneOutcomes: PayloadOutcome[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | undefined;
  onLoadMore(): void;
  onRestore(generation: PayloadGenerationDetail): void;
  onRestoreRevision(revision: PayloadRevision): void;
  onDelete(generation: PayloadGenerationDetail): void;
  onDeleteRevision(revision: PayloadRevision): void;
  restoringId?: string;
  deletingId?: string;
  deletingRevisionId?: string;
}) {
  if (!context) return <div className="payload-history-empty">Generation history is available inside a session.</div>;
  if (loading) return <div className="payload-history-empty"><span className="spinner" /> Loading generation history…</div>;
  return <section className="payload-history-panel"><header><div><History size={15} /><strong>Session generation history</strong></div><small>Restoring copies exact candidate output into this workbench; it never rewrites the conversation.</small></header>
    {error && <div className="form-error">{error}</div>}
    {standaloneRevisions.length > 0 && <section className="payload-standalone-history"><h3>Manual and transformed payloads</h3>{standaloneRevisions.filter((revision) => !revision.deletedAt).toSorted((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? "")).map((revision) => <article key={revision.id}><div><strong>{revision.operation}</strong><code>{revision.id.slice(0, 8)}</code>{revision.parentRevisionId && <small>from {revision.parentRevisionId.slice(0, 8)}</small>}<pre>{revision.text}</pre><RevisionOutcomes outcomes={standaloneOutcomes} revisionId={revision.id} /></div><div className="payload-revision-actions"><Button type="button" variant="secondary" onClick={() => onRestoreRevision(revision)}><ListRestart size={13} /> Restore to Transform</Button><Button type="button" variant="ghost" aria-label={`Delete payload revision ${revision.id}`} title="Delete this unused immutable revision" disabled={deletingRevisionId === revision.id} onClick={() => onDeleteRevision(revision)}><Trash2 size={13} /></Button></div></article>)}</section>}
    {generations.length === 0 && standaloneRevisions.length === 0 && <div className="payload-history-empty"><FileClock size={22} />No payload history in this session.</div>}
    <div className="payload-history-list">{generations.map((detail) => {
      const generation = detail.generation;
      const activeRevisions = detail.revisions.filter((revision) => !revision.deletedAt).toSorted((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""));
      const sourceCount = activeRevisions.filter((revision) => Boolean(revision.attemptId ?? revision.sourceAttemptId)).length;
      const active = ["queued", "streaming"].includes(generation.status);
      return <article key={generation.id}><div><strong>{generation.operatorInstruction || generation.feedback || "Payload generation"}</strong><small>{generation.createdAt ? new Date(generation.createdAt).toLocaleString() : generation.id.slice(0, 8)} · {sourceCount || generation.candidateCount || "?"} candidates</small>{activeRevisions.length > 0 && <details className="payload-generation-lineage"><summary>{activeRevisions.length} lineage revision{activeRevisions.length === 1 ? "" : "s"}</summary>{activeRevisions.map((revision) => <div key={revision.id}><span><b>{revision.operation}</b><code>{revision.id.slice(0, 8)}</code>{revision.parentRevisionId && <small>← {revision.parentRevisionId.slice(0, 8)}</small>}<RevisionOutcomes outcomes={detail.outcomes ?? []} revisionId={revision.id} /></span><div className="payload-revision-actions"><Button type="button" variant="ghost" title="Restore exact revision to Transform" aria-label={`Restore payload revision ${revision.id}`} onClick={() => onRestoreRevision(revision)}><ListRestart size={12} /></Button><Button type="button" variant="ghost" aria-label={`Delete payload revision ${revision.id}`} title="Delete this unused immutable revision" disabled={deletingRevisionId === revision.id} onClick={() => onDeleteRevision(revision)}><Trash2 size={12} /></Button></div></div>)}</details>}</div><span className={`status-badge status-${generation.status}`}>{generation.status}</span><div><Button type="button" variant="secondary" disabled={restoringId === generation.id} onClick={() => onRestore(detail)}><ListRestart size={13} /> Restore candidates</Button><Button type="button" variant="ghost" aria-label={`Delete generation ${generation.id}`} title={active ? "Cancel this generation before deleting it" : "Delete generation"} disabled={active || deletingId === generation.id} onClick={() => onDelete(detail)}><Trash2 size={13} /></Button></div></article>;
    })}</div>
    {hasMore && <Button type="button" variant="secondary" className="payload-history-load-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? <span className="spinner small" /> : <FileClock size={13} />} Load more</Button>}
  </section>;
}

export function PayloadWorkbench({ value, sourcePayloadRevisionId = null, context, onUse }: { value: string; sourcePayloadRevisionId?: string | null; context?: PayloadWorkbenchContext; onUse(selection: PayloadWorkbenchSelection): void }) {
  const queryClient = useQueryClient();
  const dialogs = useOperatorDialog();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<WorkbenchTab>("transform");
  const [original, setOriginal] = useState("");
  const [draft, setDraft] = useState("");
  const [draftSource, setDraftSource] = useState<{ id: string; text: string | null } | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [transformError, setTransformError] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState(defaultPayloadWorkbenchSettings);
  const [defaultsApplied, setDefaultsApplied] = useState(false);
  const [operatorInstruction, setOperatorInstruction] = useState("");
  const [profileRevisionId, setProfileRevisionId] = useState("");
  const [instructionRevisionId, setInstructionRevisionId] = useState("");
  const [techniqueRevisionIds, setTechniqueRevisionIds] = useState<string[]>([]);
  const [pipelineRevisionId, setPipelineRevisionId] = useState("");
  const [variables, setVariables] = useState<VariableOverride[]>([]);
  const [contextPreview, setContextPreview] = useState<PayloadContextPreview | null>(null);
  const previewRequestKey = useRef("");
  const [snapshotBranchId, setSnapshotBranchId] = useState<string | null>(null);
  const [snapshotHeadId, setSnapshotHeadId] = useState<string | null>(null);
  const [snapshotPath, setSnapshotPath] = useState<MessageNode[]>([]);
  const [confirmedReadOnlyProfiles, setConfirmedReadOnlyProfiles] = useState<Set<string>>(() => new Set());
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [generation, setGeneration] = useState<PayloadGeneration | null>(null);
  const [candidates, setCandidates] = useState<StreamingPayloadCandidate[]>([]);
  const [revisions, setRevisions] = useState<PayloadRevision[]>([]);
  const [diffIds, setDiffIds] = useState<string[]>([]);

  const settingsQuery = useQuery({ queryKey: ["payload-workbench", "settings"], queryFn: () => api<{ settings: unknown }>("/api/payload-workbench/settings"), enabled: open });
  const profileAssets = usePayloadAssets("payload-generator-profile", open);
  const instructionAssets = usePayloadAssets("payload-generator-instruction", open);
  const techniqueAssets = usePayloadAssets("payload-technique", open);
  const pipelineAssets = usePayloadAssets("payload-pipeline", open);
  // Keep exact immutable revisions selectable. Defaults and restored generations
  // may intentionally point at an older revision after a newer one is saved.
  const profiles = orderedRevisions(profileAssets.data?.assets ?? []);
  const instructions = orderedRevisions(instructionAssets.data?.assets ?? []);
  const techniques = orderedRevisions(techniqueAssets.data?.assets ?? []);
  const pipelines = orderedRevisions(pipelineAssets.data?.assets ?? []);
  const contextIsStale = Boolean(context && (snapshotBranchId !== context.branchId || snapshotHeadId !== context.contextNodeId));
  const selectedProfile = profiles.find((asset) => asset.id === profileRevisionId);
  const selectedProfileBackend = record(record(selectedProfile?.value).backend);
  const selectedProfileNeedsWorkspaceConfirmation = selectedProfileBackend.kind === "codex-app-server" && selectedProfileBackend.workspaceAccess === "project-read-only";
  const selectedTechniques: PayloadTechnique[] = techniqueRevisionIds.flatMap((revisionId) => {
    const asset = techniques.find((item) => item.id === revisionId);
    if (!asset) return [];
    const technique = record(asset.value);
    const ids = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return [{ revisionId: asset.id, assetId: asset.assetId, name: asset.name, instructions: typeof technique.instructions === "string" ? technique.instructions : "", conflictsWith: ids(technique.conflictsWith), before: ids(technique.before), after: ids(technique.after) }];
  });
  const techniqueWarnings = techniqueSelectionWarnings(selectedTechniques);
  const currentPreviewKey = JSON.stringify({ branchId: snapshotBranchId, contextNodeId: snapshotHeadId, options: payloadContextRequestOptions(settingsDraft), variables: variablesAsStrings(variables) });
  previewRequestKey.current = currentPreviewKey;
  const historyQuery = useInfiniteQuery({
    queryKey: ["payload-generations", context?.sessionId],
    queryFn: ({ pageParam }) => api<PayloadGenerationList>(`/api/payload-generations?sessionId=${encodeURIComponent(context?.sessionId ?? "")}&cursor=${encodeURIComponent(pageParam)}`),
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open && Boolean(context),
    refetchOnMount: "always"
  });
  const detailQuery = useQuery({
    queryKey: ["payload-generation", generationId],
    queryFn: () => api<GenerationResponse>(`/api/payload-generations/${generationId}`),
    enabled: open && Boolean(generationId),
    refetchInterval: (query) => {
      const status = query.state.data?.generation.status;
      return status && ["queued", "streaming"].includes(status) ? 1_000 : false;
    }
  });

  useEffect(() => {
    if (!open || defaultsApplied || generationId || !settingsQuery.data) return;
    const saved = normalizePayloadWorkbenchSettings(settingsQuery.data.settings);
    setSettingsDraft(saved);
    setProfileRevisionId(saved.defaultGeneratorProfileRevisionId ?? "");
    setInstructionRevisionId(saved.defaultInstructionRevisionId ?? "");
    setTechniqueRevisionIds([]);
    setPipelineRevisionId("");
    setDefaultsApplied(true);
  }, [defaultsApplied, generationId, open, settingsQuery.data]);

  useEffect(() => {
    if (!open || generationId || !historyQuery.data) return;
    const active = historyQuery.data.pages
      .flatMap((page) => page.generations ?? [])
      .filter((detail) => ["queued", "streaming"].includes(detail.generation.status))
      .toSorted((left, right) => (right.generation.createdAt ?? "").localeCompare(left.generation.createdAt ?? ""))[0];
    if (!active) return;
    const item = active.generation;
    setGenerationId(item.id);
    setGeneration(item);
    setRevisions(active.revisions);
    setCandidates(candidatesFromDetail(active));
    setDiffIds([]);
    setOperatorInstruction(item.operatorInstruction ?? "");
    setProfileRevisionId(item.generatorProfileRevisionId ?? "");
    setInstructionRevisionId(item.instructionRevisionId ?? "");
    setTechniqueRevisionIds(item.techniqueRevisionIds ?? []);
    setPipelineRevisionId(item.pipelineRevisionId ?? "");
    setVariables(variableRows(item.variables));
    if (item.contextOptions) {
      const candidateCount = Math.max(1, Math.min(4, Math.round(item.candidateCount ?? 1))) as 1 | 2 | 3 | 4;
      setSettingsDraft((current) => ({ ...current, ...item.contextOptions, candidateCount, diversity: item.diversity ?? current.diversity }));
    }
    setDefaultsApplied(true);
    setSnapshotBranchId(item.branchId);
    setSnapshotHeadId(item.contextNodeId);
    if (context) {
      const contextIndex = item.contextNodeId ? context.path.findIndex((node) => node.id === item.contextNodeId) : -1;
      setSnapshotPath(contextIndex >= 0 ? context.path.slice(0, contextIndex + 1) : context.path);
    }
    setContextPreview(null);
    setTab("generate");
  }, [context, generationId, historyQuery.data, open]);

  useEffect(() => {
    const response = detailQuery.data;
    if (!response) return;
    const detail = responseDetail(response);
    setGeneration(detail.generation);
    setRevisions(detail.revisions);
    const persisted = candidatesFromDetail(detail);
    if (persisted.length > 0) setCandidates((current) => mergePersistedCandidates(current, persisted));
  }, [detailQuery.data]);

  useEffect(() => {
    if (open) setContextPreview(null);
  }, [open, settingsDraft.contextMode, settingsDraft.includeProjectBrief, settingsDraft.includeSessionBrief, settingsDraft.includeTargetConfig, settingsDraft.budgetChars, variables]);

  useEffect(() => {
    if (!open || !generationId) return;
    const controller = new AbortController();
    void consumeEvents(`payload-generation:${generationId}`, controller.signal, (value) => {
      const envelope = eventEnvelope(value);
      if (!envelope) return;
      setCandidates((current) => reducePayloadGenerationEvent(current, envelope));
      if (/completed|partial|failed|cancelled|interrupted/.test(envelope.type)) {
        void queryClient.invalidateQueries({ queryKey: ["payload-generation", generationId] });
        void queryClient.invalidateQueries({ queryKey: ["payload-generations", context?.sessionId] });
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [context?.sessionId, generationId, open, queryClient]);

  const preview = useMutation({
    mutationFn: async ({ requestKey }: { requestKey: string }) => {
      if (!context) throw new Error("Open the workbench from a session to preview context");
      const response = await api<{ preview: unknown }>(`/api/sessions/${context.sessionId}/payload-context/preview`, { method: "POST", ...jsonBody({ branchId: snapshotBranchId ?? context.branchId, contextNodeId: snapshotHeadId, options: payloadContextRequestOptions(settingsDraft), variables: variablesAsStrings(variables) }) });
      return { requestKey, preview: normalizePayloadContextPreview(response.preview) };
    },
    onSuccess: ({ requestKey, preview: result }) => {
      if (requestKey === previewRequestKey.current) setContextPreview(result);
    }
  });
  const generate = useMutation({
    mutationFn: async ({ confirmProjectReadOnly }: { confirmProjectReadOnly: boolean }) => {
      if (!context) throw new Error("Open the workbench from a session to generate candidates");
      if (!profileRevisionId) throw new Error("Select a generator profile");
      return api<GenerationResponse>("/api/payload-generations", { method: "POST", ...jsonBody({
        sessionId: context.sessionId,
        branchId: snapshotBranchId ?? context.branchId,
        contextNodeId: snapshotHeadId,
        operatorInstruction,
        profileRevisionId,
        instructionRevisionId: instructionRevisionId || null,
        techniqueRevisionIds,
        variables: variablesObject(variables),
        context: payloadContextRequestOptions(settingsDraft),
        candidateCount: settingsDraft.candidateCount,
        diversity: settingsDraft.diversity,
        confirmProjectReadOnly
      }) });
    },
    onSuccess: (response) => {
      const detail = responseDetail(response);
      setGenerationId(detail.generation.id);
      setGeneration(detail.generation);
      setRevisions(detail.revisions);
      setCandidates(candidatesFromDetail(detail));
      setDiffIds([]);
      void queryClient.invalidateQueries({ queryKey: ["payload-generations", context?.sessionId] });
    }
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api<{ cancelled: boolean }>(`/api/payload-generations/${id}/cancel`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["payload-generation", generationId] })
  });
  const refine = useMutation({
    mutationFn: ({ revision, feedback }: { revision: PayloadRevision; feedback: string }) => api<GenerationResponse | { revision: PayloadRevision }>(`/api/payload-revisions/${revision.id}/refine`, { method: "POST", ...jsonBody({ feedback, candidateCount: settingsDraft.candidateCount, diversity: settingsDraft.diversity }) }),
    onSuccess: (response, { revision: parentRevision }) => {
      setOriginal(parentRevision.text);
      if ("generation" in response) {
        const detail = responseDetail(response);
        setGenerationId(detail.generation.id);
        setGeneration(detail.generation);
        setRevisions(detail.revisions);
        setCandidates(candidatesFromDetail(detail));
        setDiffIds([]);
      } else {
        setRevisions((current) => [...current, response.revision]);
        setCandidates((current) => [...current, { attemptId: `revision:${response.revision.id}`, revisionId: response.revision.id, ordinal: response.revision.ordinal, text: response.revision.text, reasoning: "", status: "completed", classification: null, error: null }]);
      }
      void queryClient.invalidateQueries({ queryKey: ["payload-generations", context?.sessionId] });
    }
  });
  const restore = useMutation({
    mutationFn: (item: PayloadGenerationDetail) => api<GenerationResponse>(`/api/payload-generations/${item.generation.id}`),
    onSuccess: (response) => {
      const detail = responseDetail(response);
      setGenerationId(detail.generation.id);
      setGeneration(detail.generation);
      setRevisions(detail.revisions);
      setCandidates(candidatesFromDetail(detail));
      setDiffIds([]);
      setOperatorInstruction(detail.generation.operatorInstruction ?? "");
      setProfileRevisionId(detail.generation.generatorProfileRevisionId ?? "");
      setInstructionRevisionId(detail.generation.instructionRevisionId ?? "");
      setTechniqueRevisionIds(detail.generation.techniqueRevisionIds ?? []);
      setPipelineRevisionId(detail.generation.pipelineRevisionId ?? "");
      setVariables(variableRows(detail.generation.variables));
      if (detail.generation.contextOptions) {
        const count = Math.max(1, Math.min(4, Math.round(detail.generation.candidateCount ?? 1))) as 1 | 2 | 3 | 4;
        setSettingsDraft((current) => ({ ...current, ...detail.generation.contextOptions, candidateCount: count, diversity: detail.generation.diversity ?? current.diversity }));
      }
      setContextPreview(null);
      setTab("generate");
    }
  });
  const removeGeneration = useMutation({
    mutationFn: (item: PayloadGenerationDetail) => api(`/api/payload-generations/${item.generation.id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["payload-generations", context?.sessionId] })
  });
  const removeRevision = useMutation({
    mutationFn: (revision: PayloadRevision) => api(`/api/payload-revisions/${revision.id}`, { method: "DELETE" }),
    onSuccess: (_, revision) => {
      setRevisions((current) => current.filter((item) => item.id !== revision.id));
      setDraftSource((current) => current?.id === revision.id ? null : current);
      void queryClient.invalidateQueries({ queryKey: ["payload-generations", context?.sessionId] });
    }
  });
  const derive = useMutation({
    mutationFn: async ({ revisionId, seedText, editText, body }: { revisionId?: string; seedText?: string; editText?: string; body: JsonObject | null }) => {
      let parentId = revisionId;
      let parentRevision: PayloadRevision | undefined;
      if (!parentId) {
        if (!context) throw new Error("Open this workbench from a session to record payload lineage");
        const seeded = await api<{ revision: PayloadRevision }>("/api/payload-revisions", { method: "POST", ...jsonBody({ sessionId: context.sessionId, text: seedText ?? draft }) });
        parentId = seeded.revision.id;
        parentRevision = seeded.revision;
      }
      if (parentId && editText !== undefined) {
        const edited = await api<{ revision: PayloadRevision }>(`/api/payload-revisions/${parentId}/derive`, { method: "POST", ...jsonBody({ kind: "edit", text: editText }) });
        parentId = edited.revision.id;
        parentRevision = edited.revision;
      }
      if (body === null) return { revision: parentRevision!, revisions: parentRevision ? [parentRevision] : [], completed: true, error: null };
      return api<{ revision: PayloadRevision; revisions?: PayloadRevision[]; completed?: boolean; error?: string | null }>(`/api/payload-revisions/${parentId}/derive`, { method: "POST", ...jsonBody(body) });
    }
  });

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      setOriginal(value);
      setDraft(value);
      // The composer may have changed since this source revision was selected.
      // Its persisted text is unknown here, so the first derivation records an
      // explicit edit before applying a transform or pipeline.
      setDraftSource(sourcePayloadRevisionId ? { id: sourcePayloadRevisionId, text: null } : null);
      setUndoStack([]);
      setTransformError(null);
      setTab("transform");
      setDefaultsApplied(false);
      setOperatorInstruction("");
      setVariables([]);
      setContextPreview(null);
      setSnapshotBranchId(context?.branchId ?? null);
      setSnapshotHeadId(context?.contextNodeId ?? null);
      setSnapshotPath(context?.path ?? []);
      setGenerationId(null);
      setGeneration(null);
      setCandidates([]);
      setRevisions([]);
      setDiffIds([]);
    }
    setOpen(nextOpen);
  };
  const apply = (transform: PayloadTransformDefinition) => {
    try {
      const parameters = transform.id === "render-variables" ? variablesAsStrings(variables) : undefined;
      const transformed = transform.apply(draft, parameters);
      if (transformed !== draft) setUndoStack((items) => [...items.slice(-49), draft]);
      setDraft(transformed);
      setTransformError(null);
      if (context && transformed !== draft) {
        const parent = draftSource;
        derive.mutate({ ...(parent ? { revisionId: parent.id, ...(draft !== parent.text ? { editText: draft } : {}) } : { seedText: draft }), body: { kind: "transform", transformId: transform.id, version: transform.version, ...(parameters ? { parameters } : {}) } }, {
          onSuccess: ({ revision }) => setDraftSource((current) => !parent || current?.id === parent.id ? { id: revision.id, text: revision.text } : current),
          onError: (error) => setTransformError(`The local transform succeeded, but its revision could not be recorded: ${error.message}`)
        });
      }
    } catch (caught) {
      setTransformError(caught instanceof Error ? caught.message : `${transform.label} could not be applied.`);
    }
  };
  const undo = () => {
    const prior = undoStack.at(-1);
    if (prior === undefined) return;
    setDraft(prior);
    setUndoStack((items) => items.slice(0, -1));
    setTransformError(null);
  };
  const reset = () => {
    if (draft !== original) setUndoStack((items) => [...items.slice(-49), draft]);
    setDraft(original);
    setTransformError(null);
  };
  const selectedPipeline = pipelines.find((asset) => asset.id === pipelineRevisionId);
  const runPipeline = () => {
    if (!selectedPipeline) return;
    const valueObject = jsonRecord(selectedPipeline.value);
    const steps = Array.isArray(valueObject.steps) ? valueObject.steps.flatMap((item) => {
      const step = record(item);
      if (typeof step.transformId !== "string") return [];
      const parameters = Object.fromEntries(Object.entries(record(step.parameters)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      return [{ transformId: step.transformId, version: step.version === 1 ? 1 as const : 1 as const, enabled: step.enabled !== false, ...(Object.keys(parameters).length > 0 ? { parameters } : {}) }];
    }) : [];
    try {
      const pipelineSteps: PayloadPipelineStep[] = steps.map((step) => ({
        transformId: step.transformId as PayloadTransformId,
        version: step.version,
        enabled: step.enabled,
        ...(step.transformId === "render-variables" ? { parameters: variablesAsStrings(variables) } : step.parameters ? { parameters: step.parameters } : {})
      }));
      const result = evaluatePayloadPipeline(draft, pipelineSteps);
      if (result.output !== draft) setUndoStack((items) => [...items.slice(-49), draft]);
      setDraft(result.output);
      setTransformError(result.completed ? null : result.steps.find((step) => step.error)?.error ?? "Pipeline stopped after its last successful step.");
      if (context) {
        const parent = draftSource;
        derive.mutate({ ...(parent ? { revisionId: parent.id, ...(draft !== parent.text ? { editText: draft } : {}) } : { seedText: draft }), body: { kind: "pipeline", pipelineRevisionId: selectedPipeline.id, variables: variablesObject(variables) } }, {
          onSuccess: ({ revision, error }) => {
            setDraftSource((current) => !parent || current?.id === parent.id ? { id: revision.id, text: revision.text } : current);
            if (error) setTransformError(error);
          },
          onError: (error) => setTransformError(`The local pipeline succeeded, but its revisions could not be recorded: ${error.message}`)
        });
      }
    } catch (error) {
      setTransformError(error instanceof Error ? error.message : "Pipeline failed");
    }
  };
  const sendCandidateToTransform = (candidate: StreamingPayloadCandidate, revision?: PayloadRevision) => {
    setDraft(candidate.text);
    setDraftSource(revision ? { id: revision.id, text: revision.text } : null);
    setOriginal(candidate.text);
    setUndoStack([]);
    setTransformError(null);
    setTab("transform");
  };
  const useCandidate = (candidate: StreamingPayloadCandidate, revision?: PayloadRevision) => {
    onUse({ text: candidate.text, sourcePayloadRevisionId: revision?.id ?? null });
    setOpen(false);
  };
  const requestGenerate = async () => {
    if (!context || contextIsStale || (generation && ["queued", "streaming"].includes(generation.status))) return;
    let confirmed = false;
    if (selectedProfileNeedsWorkspaceConfirmation) {
      const trustKey = `${context.sessionId}:${profileRevisionId}`;
      if (!confirmedReadOnlyProfiles.has(trustKey)) {
        confirmed = await dialogs.confirm({
          title: "Allow project read-only generator access?",
          description: "This Codex App Server profile can read the selected project's workspace while generating payloads. Approval is scoped to this exact session and profile revision.",
          confirmLabel: "Allow this profile"
        });
        if (!confirmed) return;
        setConfirmedReadOnlyProfiles((current) => new Set(current).add(trustKey));
      } else confirmed = true;
    }
    generate.mutate({ confirmProjectReadOnly: selectedProfileNeedsWorkspaceConfirmation && confirmed });
  };
  const requestGenerationDelete = async (detail: PayloadGenerationDetail) => {
    if (["queued", "streaming"].includes(detail.generation.status)) return;
    const approved = await dialogs.confirm({ title: "Delete payload generation?", description: "This removes the generation from workbench history. Lathe will reject deletion if transcript or evidence still references one of its revisions.", confirmLabel: "Delete generation", danger: true });
    if (approved) removeGeneration.mutate(detail);
  };
  const requestRevisionDelete = async (revision: PayloadRevision) => {
    const approved = await dialogs.confirm({ title: `Delete payload revision ${revision.id.slice(0, 8)}?`, description: "This removes only this immutable revision. Lathe will reject deletion when a transcript, outcome, or descendant still references it.", confirmLabel: "Delete revision", danger: true });
    if (approved) removeRevision.mutate(revision);
  };
  const useDraft = () => {
    if (!draftSource && context) {
      derive.mutate({ seedText: draft, body: null }, {
        onSuccess: ({ revision }) => {
          onUse({ text: revision.text, sourcePayloadRevisionId: revision.id });
          setOpen(false);
        }
      });
      return;
    }
    if (!draftSource || draft === draftSource.text) {
      onUse({ text: draft, sourcePayloadRevisionId: draftSource?.id ?? null });
      setOpen(false);
      return;
    }
    derive.mutate({ revisionId: draftSource.id, body: { kind: "edit", text: draft } }, {
      onSuccess: ({ revision }) => {
        onUse({ text: revision.text, sourcePayloadRevisionId: revision.id });
        setOpen(false);
      }
    });
  };
  const byteCount = new TextEncoder().encode(draft).byteLength;
  const libraryError = settingsQuery.error ?? profileAssets.error ?? instructionAssets.error ?? techniqueAssets.error ?? pipelineAssets.error;
  const snapshotContext = context ? { ...context, branchId: snapshotBranchId ?? context.branchId, contextNodeId: snapshotHeadId, path: snapshotPath } : undefined;
  const historyPages = historyQuery.data?.pages ?? [];
  const historyGenerations = uniqueById(historyPages.flatMap((page) => page.generations).map((detail) => ({ ...detail, id: detail.generation.id }))).map(({ id: _, ...detail }) => detail);
  const historyStandaloneRevisions = uniqueById(historyPages.flatMap((page) => page.standaloneRevisions ?? []));
  const historyStandaloneOutcomes = uniqueOutcomes(historyPages.flatMap((page) => page.standaloneOutcomes ?? []));

  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><Button type="button" variant="secondary" className="payload-workbench-trigger" title="Open payload workbench" aria-label="Open payload workbench"><WandSparkles size={16} /></Button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content payload-workbench-dialog">
      <div className="payload-workbench-heading"><span className="payload-workbench-mark"><Sparkles size={17} /></span><div><Dialog.Title>Payload workbench</Dialog.Title><Dialog.Description>Transform exact text or generate inspected candidates. Nothing enters the conversation until you explicitly use it.</Dialog.Description>{context && <div className="payload-workbench-context"><span>{context.sessionName}</span><span>{context.branchName}</span><code>{context.contextNodeId?.slice(0, 8) ?? "root"}</code></div>}</div></div>
      <Tabs.Root value={tab} onValueChange={(nextTab) => setTab(nextTab as WorkbenchTab)} className="payload-workbench-tabs">
        <Tabs.List><Tabs.Trigger value="transform"><Braces size={13} /> Transform</Tabs.Trigger><Tabs.Trigger value="generate"><Sparkles size={13} /> Generate</Tabs.Trigger><Tabs.Trigger value="history"><History size={13} /> History</Tabs.Trigger></Tabs.List>
        <Tabs.Content value="transform" className="payload-workbench-tab-content">
          <div className="payload-workbench-layout">
            <section className="payload-workbench-editor"><Field label="Next prompt"><Textarea autoFocus value={draft} onChange={(event) => { setDraft(event.target.value); setTransformError(null); }} rows={18} maxLength={1_000_000} placeholder="Draft the next payload…" /></Field><div className="payload-workbench-stats"><span>{draft.length.toLocaleString()} characters</span><span>{byteCount.toLocaleString()} UTF-8 bytes</span><span>{undoStack.length} undo step{undoStack.length === 1 ? "" : "s"}</span>{draftSource && <span>lineage · {draftSource.id.slice(0, 8)}</span>}</div>{(transformError || derive.error) && <div className="form-error" role="alert">{transformError ?? derive.error?.message}</div>}</section>
            <aside className="payload-toolbox" aria-label="Payload transformations">
              {payloadTransformGroups.map((group) => <section className="payload-tool-group" key={group.label}><h3><TransformGroupIcon icon={group.icon} />{group.label}</h3><div>{group.transforms.map((transform) => <button type="button" disabled={derive.isPending} onClick={() => apply(transform)} key={transform.id}>{transform.label}</button>)}</div></section>)}
              <section className="payload-tool-group payload-pipeline-runner"><h3><Play size={13} /> Saved pipeline</h3><Select aria-label="Transform pipeline" value={pipelineRevisionId} onChange={(event) => setPipelineRevisionId(event.target.value)}><option value="">Select pipeline…</option>{pipelines.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select>{selectedPipeline && <small>{selectedPipeline.description || "Its ordered deterministic steps are applied exactly."}</small>}<Button type="button" variant="secondary" onClick={runPipeline} disabled={!selectedPipeline || derive.isPending}><Play size={12} /> Apply pipeline</Button></section>
              <VariableOverridesEditor rows={variables} onChange={setVariables} />
            </aside>
          </div>
        </Tabs.Content>
        <Tabs.Content value="generate" className="payload-workbench-tab-content">
          <div className="payload-generate-layout"><aside className="payload-generate-controls">
            {!context && <div className="form-error">Open this workbench from a session to generate candidates.</div>}
            {libraryError && <div className="form-error">{libraryError.message}</div>}
            <Field label="Generator profile"><Select value={profileRevisionId} onChange={(event) => setProfileRevisionId(event.target.value)}><option value="">Select profile…</option>{profiles.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select></Field>
            <Field label="Reusable instruction"><Select value={instructionRevisionId} onChange={(event) => setInstructionRevisionId(event.target.value)}><option value="">None</option>{instructions.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select></Field>
            <Field label="Operator instruction"><Textarea value={operatorInstruction} onChange={(event) => setOperatorInstruction(event.target.value)} rows={5} placeholder="Describe the attack objective, constraints, and variations to explore…" /></Field>
            <OrderedTechniques assets={techniques} selected={techniqueRevisionIds} onChange={setTechniqueRevisionIds} />
            {techniqueWarnings.length > 0 && <div className="payload-technique-warnings" role="status">{techniqueWarnings.map((warning, index) => <p key={`${warning.techniqueRevisionId}:${warning.code}:${index}`}>{warning.message}</p>)}</div>}
            <VariableOverridesEditor rows={variables} onChange={setVariables} />
            <div className="two-fields"><Field label="Candidates"><Select value={settingsDraft.candidateCount} onChange={(event) => setSettingsDraft({ ...settingsDraft, candidateCount: Number(event.target.value) as 1 | 2 | 3 | 4 })}>{[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}</Select></Field><Field label="Diversity"><Select value={settingsDraft.diversity} onChange={(event) => setSettingsDraft({ ...settingsDraft, diversity: event.target.value as PayloadWorkbenchSettings["diversity"] })}><option value="low">Low</option><option value="balanced">Balanced</option><option value="high">High</option></Select></Field></div>
            {contextIsStale && context && <div className="payload-stale-context warning"><div><strong>Conversation head moved</strong><span>This workbench is pinned to {snapshotHeadId?.slice(0, 8) ?? "root"}; refresh before generating from {context.contextNodeId?.slice(0, 8) ?? "root"}.</span></div><Button type="button" variant="secondary" onClick={() => { setSnapshotBranchId(context.branchId); setSnapshotHeadId(context.contextNodeId); setSnapshotPath(context.path); setContextPreview(null); }}><RefreshCw size={12} /> Refresh context</Button></div>}
            {snapshotContext && <ContextControls value={settingsDraft} onChange={setSettingsDraft} onPreview={() => preview.mutate({ requestKey: currentPreviewKey })} preview={contextPreview} pending={preview.isPending} error={preview.error?.message} context={snapshotContext} />}
            {(generate.error || refine.error) && <div className="form-error">{generate.error?.message ?? refine.error?.message}</div>}
            <div className="payload-generate-actions">{generation && ["queued", "streaming"].includes(generation.status) && <Button type="button" variant="danger" aria-label="Cancel payload generation" onClick={() => cancel.mutate(generation.id)} disabled={cancel.isPending}><CircleStop size={13} /> Cancel</Button>}<Button type="button" onClick={() => void requestGenerate()} disabled={!context || contextIsStale || contextPreview?.fits === false || !profileRevisionId || !operatorInstruction.trim() || generate.isPending || Boolean(generation && ["queued", "streaming"].includes(generation.status))}><Sparkles size={13} />{generate.isPending ? "Starting…" : "Generate candidates"}</Button></div>
          </aside>
          <main className="payload-generate-results"><GenerationCandidates generation={generation} candidates={candidates} revisions={revisions} original={original} diffIds={diffIds} onDiffChange={setDiffIds} onRefine={(revision, feedback) => refine.mutate({ revision, feedback })} onTransform={sendCandidateToTransform} onUse={useCandidate} refinePending={refine.isPending} />{detailQuery.error && <div className="form-error">{detailQuery.error.message}</div>}</main></div>
        </Tabs.Content>
        <Tabs.Content value="history" className="payload-workbench-tab-content"><HistoryPanel {...(context ? { context } : {})} generations={historyGenerations} standaloneRevisions={historyStandaloneRevisions} standaloneOutcomes={historyStandaloneOutcomes} loading={historyQuery.isLoading} loadingMore={historyQuery.isFetchingNextPage} hasMore={historyQuery.hasNextPage} error={historyQuery.error?.message ?? restore.error?.message ?? removeGeneration.error?.message ?? removeRevision.error?.message} onLoadMore={() => void historyQuery.fetchNextPage()} onRestore={(item) => restore.mutate(item)} onRestoreRevision={(revision) => { setDraft(revision.text); setDraftSource({ id: revision.id, text: revision.text }); setOriginal(revision.text); setUndoStack([]); setTransformError(null); setTab("transform"); }} onDelete={(item) => void requestGenerationDelete(item)} onDeleteRevision={(revision) => void requestRevisionDelete(revision)} {...(restore.variables?.generation.id ? { restoringId: restore.variables.generation.id } : {})} {...(removeGeneration.variables?.generation.id ? { deletingId: removeGeneration.variables.generation.id } : {})} {...(removeRevision.variables?.id ? { deletingRevisionId: removeRevision.variables.id } : {})} /></Tabs.Content>
      </Tabs.Root>
      <div className="payload-workbench-footer"><div><Button type="button" variant="ghost" onClick={undo} disabled={undoStack.length === 0 || derive.isPending}><Undo2 size={14} /> Undo</Button><Button type="button" variant="ghost" onClick={reset} disabled={draft === original || derive.isPending}><RotateCcw size={14} /> Reset</Button></div><div><Dialog.Close asChild><Button type="button" variant="ghost">Cancel</Button></Dialog.Close><Button type="button" onClick={useDraft} disabled={draft.trim().length === 0 || derive.isPending}><WandSparkles size={14} /> {derive.isPending ? "Recording…" : "Use as next prompt"}</Button></div></div>
      <Dialog.Close className="dialog-close" aria-label="Close payload workbench"><X size={17} /></Dialog.Close>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
