import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowDown, ArrowUp, Braces, FileText, FlaskConical, Gauge, Pencil, Plus, RotateCcw, Save, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import type { JsonObject, JsonValue } from "@lathe/domain";
import { getPayloadTransform, payloadTransforms, type PayloadTransformId } from "@lathe/payloads";
import { api, jsonBody } from "../api.js";
import {
  defaultPayloadWorkbenchSettings,
  normalizePayloadWorkbenchSettings,
  type PayloadAssetKind,
  type PayloadAssetRevision,
  type PayloadWorkbenchSettings
} from "../payload-workbench-api.js";
import type { SafeProvider } from "../types.js";
import { Button, Field, Input, Select, Textarea } from "./forms.js";
import { useOperatorDialog } from "./operator-dialog.js";

type SettingsTab = "profiles" | "instructions" | "techniques" | "pipelines" | "defaults";

const payloadTransformIds = payloadTransforms.map((transform) => transform.id);
const payloadTransformLabel = (id: string) => getPayloadTransform(id as PayloadTransformId).label;

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringField(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanField(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: JsonValue | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function selectedValues(event: ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.currentTarget.selectedOptions, (option) => option.value);
}

function currentRevisions(assets: PayloadAssetRevision[]): PayloadAssetRevision[] {
  const latest = new Map<string, PayloadAssetRevision>();
  for (const asset of assets) {
    const prior = latest.get(asset.assetId);
    if (!prior || prior.revision < asset.revision) latest.set(asset.assetId, asset);
  }
  return [...latest.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

function orderedRevisions(assets: PayloadAssetRevision[]): PayloadAssetRevision[] {
  return [...assets].toSorted((left, right) => left.name.localeCompare(right.name) || right.revision - left.revision);
}

function usePayloadAssets(kind: PayloadAssetKind, enabled: boolean) {
  return useQuery({
    queryKey: ["assets", kind],
    queryFn: () => api<{ assets: PayloadAssetRevision[] }>(`/api/assets?kind=${encodeURIComponent(kind)}`),
    enabled
  });
}

interface SaveAssetInput {
  kind: PayloadAssetKind;
  name: string;
  description: string;
  tags?: string[];
  value: JsonValue;
  editing?: PayloadAssetRevision | null;
}

function useAssetMutations(onSaved?: () => void) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: ({ kind, name, description, tags, value, editing }: SaveAssetInput) => api<{ asset: PayloadAssetRevision }>("/api/library/assets", {
      method: "POST",
      ...jsonBody({
        ...(editing ? { assetId: editing.assetId, baseRevisionId: editing.id } : {}),
        kind,
        name,
        description,
        tags: tags ?? editing?.tags ?? [],
        provenance: editing
          ? { ...editing.provenance, operatorAuthored: true, editedFromRevisionId: editing.id, operatorEditedAt: new Date().toISOString() }
          : { operatorAuthored: true },
        value,
        trusted: true
      })
    }),
    onSuccess: ({ asset }) => {
      void queryClient.invalidateQueries({ queryKey: ["assets", asset.kind] });
      onSaved?.();
    }
  });
  const remove = useMutation({
    mutationFn: (asset: PayloadAssetRevision) => api(`/api/library/assets/${asset.id}`, { method: "DELETE" }),
    onSuccess: (_, asset) => void queryClient.invalidateQueries({ queryKey: ["assets", asset.kind] })
  });
  return { save, remove };
}

function LibraryCards({ assets, editingId, onEdit, onDelete, extra }: {
  assets: PayloadAssetRevision[];
  editingId: string | undefined;
  onEdit(asset: PayloadAssetRevision): void;
  onDelete(asset: PayloadAssetRevision): void;
  extra?(asset: PayloadAssetRevision): ReactNode;
}) {
  const revisions = orderedRevisions(assets);
  const heads = new Map(currentRevisions(assets).map((asset) => [asset.assetId, asset.id]));
  if (revisions.length === 0) return <p className="payload-library-empty">Nothing saved yet.</p>;
  return <div className="payload-library-cards">{revisions.map((asset) => {
    const isHead = heads.get(asset.assetId) === asset.id;
    return <article className={`payload-library-card${editingId === asset.id ? " editing" : ""}`} key={asset.id}>
    <div><strong>{asset.name}</strong><span>r{asset.revision}</span></div>
    <p>{asset.description || "No description"}</p>
    <small>{asset.contentHash.slice(0, 12)}…</small>
    <div className="payload-library-card-actions">
      {extra?.(asset)}
      <Button type="button" variant="ghost" aria-label={`Edit ${asset.name}`} title={isHead ? "Edit as a new immutable revision" : "Only the current head revision can be edited"} disabled={!isHead} onClick={() => onEdit(asset)}><Pencil size={13} /></Button>
      <Button type="button" variant="ghost" aria-label={`Delete ${asset.name}`} title="Delete revision" onClick={() => onDelete(asset)}><Trash2 size={13} /></Button>
    </div>
  </article>;
  })}</div>;
}

function GeneratorProfilesPanel({ assets, providers }: { assets: PayloadAssetRevision[]; providers: SafeProvider[] }) {
  const dialogs = useOperatorDialog();
  const [editing, setEditing] = useState<PayloadAssetRevision | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [backendKind, setBackendKind] = useState<"http-provider" | "codex-app-server">("http-provider");
  const [providerRevisionId, setProviderRevisionId] = useState("");
  const [httpModel, setHttpModel] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [reasoning, setReasoning] = useState(true);
  const [temperatureLow, setTemperatureLow] = useState(0.2);
  const [temperatureBalanced, setTemperatureBalanced] = useState(0.7);
  const [temperatureHigh, setTemperatureHigh] = useState(1);
  const [executablePath, setExecutablePath] = useState("");
  const [expectedVersion, setExpectedVersion] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<"low" | "medium" | "high" | "xhigh">("medium");
  const [timeoutMs, setTimeoutMs] = useState(120_000);
  const [workspaceAccess, setWorkspaceAccess] = useState<"isolated" | "project-read-only">("isolated");
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<{ assetId: string; value: JsonObject } | null>(null);
  const reset = () => {
    setEditing(null); setName(""); setDescription(""); setBackendKind("http-provider"); setProviderRevisionId(""); setHttpModel("");
    setMaxOutputTokens(""); setReasoning(true); setTemperatureLow(0.2); setTemperatureBalanced(0.7); setTemperatureHigh(1);
    setExecutablePath(""); setExpectedVersion(""); setModel(""); setEffort("medium"); setTimeoutMs(120_000); setWorkspaceAccess("isolated");
  };
  const mutations = useAssetMutations(reset);
  const requestDelete = async (asset: PayloadAssetRevision) => {
    const approved = await dialogs.confirm({ title: `Delete profile “${asset.name}”?`, description: "This removes only this immutable revision. Lathe will refuse deletion if saved settings or generation evidence still reference it.", confirmLabel: "Delete revision", danger: true });
    if (approved) mutations.remove.mutate(asset);
  };
  const probe = useMutation({
    mutationFn: (asset: PayloadAssetRevision) => api<{ probe: JsonObject }>(`/api/payload-generator-profiles/${asset.id}/probe`, { method: "POST" }),
    onSuccess: ({ probe: value }, asset) => {
      setProbeResult({ assetId: asset.id, value });
      const warnings = stringArray(value.warnings);
      setProbeMessage(value.ready === false ? "Backend responded, but the selected model is not in its catalog." : warnings.length > 0 ? `Backend is ready with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.` : "Backend probe succeeded.");
    },
    onError: (error) => setProbeMessage(error.message)
  });
  const beginEdit = (asset: PayloadAssetRevision) => {
    const value = record(asset.value);
    const backend = record(value.backend);
    const kind = backend.kind === "codex-app-server" ? "codex-app-server" : "http-provider";
    setEditing(asset); setName(asset.name); setDescription(asset.description); setBackendKind(kind);
    setProviderRevisionId(stringField(backend.providerProfileRevisionId));
    setHttpModel(stringField(backend.modelId));
    setMaxOutputTokens(typeof backend.maxOutputTokens === "number" ? String(backend.maxOutputTokens) : "");
    setReasoning(booleanField(backend.reasoning, true));
    const temperatures = record(backend.temperatures);
    setTemperatureLow(numberField(temperatures.low, 0.2));
    setTemperatureBalanced(numberField(temperatures.balanced, 0.7));
    setTemperatureHigh(numberField(temperatures.high, 1));
    setExecutablePath(stringField(backend.executablePath));
    setExpectedVersion(stringField(backend.expectedVersion));
    setModel(stringField(backend.modelId));
    setEffort(["low", "medium", "high", "xhigh"].includes(stringField(backend.effort)) ? stringField(backend.effort) as typeof effort : "medium");
    setTimeoutMs(numberField(backend.timeoutMs, 120_000));
    setWorkspaceAccess(backend.workspaceAccess === "project-read-only" ? "project-read-only" : "isolated");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const backend: JsonObject = backendKind === "http-provider"
      ? {
          kind: backendKind,
          providerProfileRevisionId: providerRevisionId,
          modelId: httpModel,
          maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null,
          reasoning,
          temperatures: { low: temperatureLow, balanced: temperatureBalanced, high: temperatureHigh }
        }
      : {
          kind: backendKind,
          executablePath,
          expectedVersion: expectedVersion || null,
          modelId: model,
          effort,
          timeoutMs,
          workspaceAccess
        };
    mutations.save.mutate({ kind: "payload-generator-profile", name, description, value: { backend }, editing });
  };
  const activeProbe = probeResult && editing?.id === probeResult.assetId ? probeResult.value : null;
  const discoveredModels = (Array.isArray(activeProbe?.models) ? activeProbe.models : []).flatMap((item) => {
    const candidate = record(item);
    const id = stringField(candidate.id) || stringField(candidate.model);
    return id ? [id] : [];
  });
  return <SettingsLibraryLayout
    title="Generator profiles"
    description="Choose the backend that creates candidate payloads. This is separate from the target model in a session."
    list={<LibraryCards assets={assets} editingId={editing?.id} onEdit={beginEdit} onDelete={(asset) => void requestDelete(asset)} extra={(asset) => <Button type="button" variant="ghost" aria-label={`Probe ${asset.name}`} title="Probe backend" onClick={() => probe.mutate(asset)}><FlaskConical size={13} /></Button>} />}
    editor={<form onSubmit={submit} className="payload-settings-form">
      <EditorHeading editing={editing} onCancel={reset}>profile</EditorHeading>
      <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
      <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
      <Field label="Backend"><Select value={backendKind} onChange={(event) => setBackendKind(event.target.value as typeof backendKind)}><option value="http-provider">HTTP provider</option><option value="codex-app-server">Codex app-server</option></Select></Field>
      {backendKind === "http-provider" ? <>
        <div className="two-fields"><Field label="Provider revision"><Select value={providerRevisionId} onChange={(event) => { setProviderRevisionId(event.target.value); const provider = providers.find((item) => item.id === event.target.value); if (provider?.models.length === 1) setHttpModel(provider.models[0]?.id ?? ""); }} required><option value="">Select…</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label} · r{provider.revision}</option>)}</Select></Field><Field label="Model" hint="Catalog model or an endpoint-compatible custom ID."><Input list="payload-http-models" value={httpModel} onChange={(event) => setHttpModel(event.target.value)} required /><datalist id="payload-http-models">{providers.find((provider) => provider.id === providerRevisionId)?.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist></Field></div>
        <div className="two-fields"><Field label="Max output tokens" hint="Blank uses the provider/model default."><Input type="number" min="1" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} /></Field><Field label="Reasoning"><Select value={reasoning ? "on" : "off"} onChange={(event) => setReasoning(event.target.value === "on")}><option value="on">Capture</option><option value="off">Disable</option></Select></Field></div>
        <div className="three-fields"><Field label="Low temperature"><Input type="number" min="0" max="2" step="0.1" value={temperatureLow} onChange={(event) => setTemperatureLow(Number(event.target.value))} /></Field><Field label="Balanced"><Input type="number" min="0" max="2" step="0.1" value={temperatureBalanced} onChange={(event) => setTemperatureBalanced(Number(event.target.value))} /></Field><Field label="High"><Input type="number" min="0" max="2" step="0.1" value={temperatureHigh} onChange={(event) => setTemperatureHigh(Number(event.target.value))} /></Field></div>
      </> : <>
        <Field label="Executable path" hint="Absolute path required; for example /opt/homebrew/bin/codex."><Input value={executablePath} onChange={(event) => setExecutablePath(event.target.value)} placeholder="/absolute/path/to/codex" required /></Field>
        <div className="two-fields"><Field label="Model"><Input value={model} onChange={(event) => setModel(event.target.value)} required /></Field><Field label="Expected version"><Input value={expectedVersion} onChange={(event) => setExpectedVersion(event.target.value)} placeholder="Optional pin" /></Field></div>
        {discoveredModels.length > 0 && <Field label="Discovered models" hint="Probe results are sanitized by the server."><Select value={discoveredModels.includes(model) ? model : ""} onChange={(event) => { if (event.target.value) setModel(event.target.value); }}><option value="">Copy a discovered model…</option>{discoveredModels.map((id) => <option key={id} value={id}>{id}</option>)}</Select></Field>}
        <div className="three-fields"><Field label="Reasoning effort"><Select value={effort} onChange={(event) => setEffort(event.target.value as typeof effort)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">X-high</option></Select></Field><Field label="Timeout (ms)"><Input type="number" min="1000" max="1800000" value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} /></Field><Field label="Workspace access"><Select value={workspaceAccess} onChange={(event) => setWorkspaceAccess(event.target.value as typeof workspaceAccess)}><option value="isolated">Isolated</option><option value="project-read-only">Project read-only</option></Select></Field></div>
      </>}
      {(mutations.save.error || mutations.remove.error) && <div className="form-error">{mutations.save.error?.message ?? mutations.remove.error?.message}</div>}
      {probeMessage && <p className="payload-probe-result">{probeMessage}</p>}
      {activeProbe && <details className="payload-probe-details" open><summary>Sanitized probe evidence</summary>{activeProbe.runtime !== undefined && <><strong>Runtime</strong><pre>{JSON.stringify(activeProbe.runtime, null, 2)}</pre></>}{activeProbe.auth !== undefined && <><strong>Authentication</strong><pre>{JSON.stringify(activeProbe.auth, null, 2)}</pre></>}{stringArray(activeProbe.warnings).length > 0 && <><strong>Warnings</strong><ul>{stringArray(activeProbe.warnings).map((warning) => <li key={warning}>{warning}</li>)}</ul></>}</details>}
      <Button disabled={!name || (backendKind === "http-provider" ? !providerRevisionId || !httpModel : !executablePath || !model) || mutations.save.isPending}><Save size={13} /> {editing ? "Save new revision" : "Save profile"}</Button>
    </form>}
  />;
}

function TextAssetPanel({ kind, noun, assets }: { kind: "payload-generator-instruction" | "payload-technique"; noun: string; assets: PayloadAssetRevision[] }) {
  const dialogs = useOperatorDialog();
  const [editing, setEditing] = useState<PayloadAssetRevision | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [template, setTemplate] = useState("");
  const [conflictsWith, setConflictsWith] = useState<string[]>([]);
  const [before, setBefore] = useState<string[]>([]);
  const [after, setAfter] = useState<string[]>([]);
  const reset = () => { setEditing(null); setName(""); setDescription(""); setTags(""); setTemplate(""); setConflictsWith([]); setBefore([]); setAfter([]); };
  const mutations = useAssetMutations(reset);
  const requestDelete = async (asset: PayloadAssetRevision) => {
    const approved = await dialogs.confirm({ title: `Delete ${noun} “${asset.name}”?`, description: "This removes only this immutable revision. References in defaults, generations, and evidence are checked before deletion.", confirmLabel: "Delete revision", danger: true });
    if (approved) mutations.remove.mutate(asset);
  };
  const edit = (asset: PayloadAssetRevision) => {
    const value = record(asset.value);
    setEditing(asset); setName(asset.name); setDescription(asset.description); setTags(asset.tags.join(", "));
    setTemplate(kind === "payload-technique" ? stringField(value.instructions) : stringField(value.template));
    setConflictsWith(stringArray(value.conflictsWith));
    setBefore(stringArray(value.before));
    setAfter(stringArray(value.after));
  };
  const constraintOptions = currentRevisions(assets).filter((asset) => asset.assetId !== editing?.assetId);
  return <SettingsLibraryLayout
    title={`${noun[0]?.toUpperCase()}${noun.slice(1)}s`}
    description={kind === "payload-generator-instruction" ? "Reusable instructions define how the generator should approach the operator's request." : "Techniques are composable attack-pattern blocks. Their selected order is preserved in every generation."}
    list={<LibraryCards assets={assets} editingId={editing?.id} onEdit={edit} onDelete={(asset) => void requestDelete(asset)} />}
    editor={<form className="payload-settings-form" onSubmit={(event) => { event.preventDefault(); mutations.save.mutate({ kind, name, description, ...(kind === "payload-technique" ? { tags: [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))] } : {}), value: kind === "payload-technique" ? { instructions: template, conflictsWith, before, after } : { template }, editing }); }}>
      <EditorHeading editing={editing} onCancel={reset}>{noun}</EditorHeading>
      <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
      <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
      {kind === "payload-technique" && <Field label="Tags" hint="Comma-separated labels for filtering and attack-taxonomy grouping."><Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="prompt-injection, encoding" /></Field>}
      <Field label={kind === "payload-generator-instruction" ? "Instruction template" : "Technique instructions"} hint="Use {{name}} placeholders to consume per-generation variable overrides."><Textarea value={template} onChange={(event) => setTemplate(event.target.value)} rows={10} required /></Field>
      {kind === "payload-technique" && <div className="three-fields payload-technique-constraints">
        <Field label="Conflicts with" hint="Logical techniques that should not be combined."><Select multiple size={Math.min(5, Math.max(2, constraintOptions.length))} value={conflictsWith} onChange={(event) => setConflictsWith(selectedValues(event))}>{constraintOptions.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.name}</option>)}</Select></Field>
        <Field label="Should come before"><Select multiple size={Math.min(5, Math.max(2, constraintOptions.length))} value={before} onChange={(event) => setBefore(selectedValues(event))}>{constraintOptions.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.name}</option>)}</Select></Field>
        <Field label="Should come after"><Select multiple size={Math.min(5, Math.max(2, constraintOptions.length))} value={after} onChange={(event) => setAfter(selectedValues(event))}>{constraintOptions.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.name}</option>)}</Select></Field>
      </div>}
      {(mutations.save.error || mutations.remove.error) && <div className="form-error">{mutations.save.error?.message ?? mutations.remove.error?.message}</div>}
      <Button disabled={!name || !template || mutations.save.isPending}><Save size={13} /> {editing ? "Save new revision" : `Save ${noun}`}</Button>
    </form>}
  />;
}

interface PipelineStepDraft { id: string; transformId: string; enabled: boolean; parameters?: Record<string, string> }

function PipelinePanel({ assets }: { assets: PayloadAssetRevision[] }) {
  const dialogs = useOperatorDialog();
  const [editing, setEditing] = useState<PayloadAssetRevision | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<PipelineStepDraft[]>([]);
  const [newTransform, setNewTransform] = useState<string>(payloadTransformIds[0] ?? "base64-encode");
  const reset = () => { setEditing(null); setName(""); setDescription(""); setSteps([]); };
  const mutations = useAssetMutations(reset);
  const requestDelete = async (asset: PayloadAssetRevision) => {
    const approved = await dialogs.confirm({ title: `Delete pipeline “${asset.name}”?`, description: "This removes only this immutable revision. Any referenced revision will be protected with a conflict error.", confirmLabel: "Delete revision", danger: true });
    if (approved) mutations.remove.mutate(asset);
  };
  const edit = (asset: PayloadAssetRevision) => {
    const value = record(asset.value);
    const storedSteps = Array.isArray(value.steps) ? value.steps : [];
    setEditing(asset); setName(asset.name); setDescription(asset.description);
    setSteps(storedSteps.flatMap((item, index) => {
      const step = record(item);
      const transformId = stringField(step.transformId) || stringField(step.id);
      return payloadTransformIds.includes(transformId as PayloadTransformId) ? [{ id: `${index}-${transformId}`, transformId, enabled: step.enabled !== false, ...(Object.keys(stringRecord(step.parameters)).length > 0 ? { parameters: stringRecord(step.parameters) } : {}) }] : [];
    }));
  };
  const move = (index: number, direction: -1 | 1) => setSteps((prior) => {
    const target = index + direction;
    if (target < 0 || target >= prior.length) return prior;
    const next = [...prior];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  });
  return <SettingsLibraryLayout
    title="Transform pipelines"
    description="Save an ordered sequence of deterministic transforms. Add Render variables wherever template overrides should be applied."
    list={<LibraryCards assets={assets} editingId={editing?.id} onEdit={edit} onDelete={(asset) => void requestDelete(asset)} />}
    editor={<form className="payload-settings-form" onSubmit={(event) => { event.preventDefault(); mutations.save.mutate({ kind: "payload-pipeline", name, description, value: { steps: steps.map((step) => ({ transformId: step.transformId, version: 1, enabled: step.enabled, ...(step.parameters ? { parameters: step.parameters } : {}) })) }, editing }); }}>
      <EditorHeading editing={editing} onCancel={reset}>pipeline</EditorHeading>
      <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
      <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
      <div className="payload-pipeline-builder" aria-label="Ordered transform steps">
        {steps.map((step, index) => <div key={step.id}><span>{index + 1}</span><label className="payload-pipeline-enabled"><input type="checkbox" checked={step.enabled} onChange={(event) => setSteps((prior) => prior.map((item) => item.id === step.id ? { ...item, enabled: event.target.checked } : item))} /><strong>{payloadTransformLabel(step.transformId)}</strong></label><Button type="button" variant="ghost" aria-label={`Move ${payloadTransformLabel(step.transformId)} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></Button><Button type="button" variant="ghost" aria-label={`Move ${payloadTransformLabel(step.transformId)} down`} disabled={index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></Button><Button type="button" variant="ghost" aria-label={`Remove ${payloadTransformLabel(step.transformId)}`} onClick={() => setSteps((prior) => prior.filter((_, itemIndex) => itemIndex !== index))}><X size={12} /></Button></div>)}
        {steps.length === 0 && <p>No transforms yet.</p>}
      </div>
      <div className="payload-pipeline-add"><Select aria-label="Transform to add" value={newTransform} onChange={(event) => setNewTransform(event.target.value)}>{payloadTransformIds.map((id) => <option key={id} value={id}>{payloadTransformLabel(id)}</option>)}</Select><Button type="button" variant="secondary" onClick={() => setSteps((prior) => [...prior, { id: `${Date.now()}-${prior.length}`, transformId: newTransform, enabled: true }])}><Plus size={13} /> Add</Button></div>
      {(mutations.save.error || mutations.remove.error) && <div className="form-error">{mutations.save.error?.message ?? mutations.remove.error?.message}</div>}
      <Button disabled={!name || steps.length === 0 || mutations.save.isPending}><Save size={13} /> {editing ? "Save new revision" : "Save pipeline"}</Button>
    </form>}
  />;
}

function DefaultsPanel({ settings, profiles, instructions }: { settings: PayloadWorkbenchSettings; profiles: PayloadAssetRevision[]; instructions: PayloadAssetRevision[] }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const save = useMutation({
    mutationFn: () => api<{ settings: PayloadWorkbenchSettings }>("/api/payload-workbench/settings", { method: "PUT", ...jsonBody(draft) }),
    onSuccess: ({ settings: saved }) => {
      queryClient.setQueryData(["payload-workbench", "settings"], { settings: saved });
      setDraft(normalizePayloadWorkbenchSettings(saved));
    }
  });
  return <div className="payload-defaults-panel">
    <div><h3>Generation defaults</h3><p>These defaults seed each session workbench. Operators can override them for a single generation.</p></div>
    <form className="payload-settings-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div className="two-fields"><Field label="Generator profile"><Select value={draft.defaultGeneratorProfileRevisionId ?? ""} onChange={(event) => setDraft({ ...draft, defaultGeneratorProfileRevisionId: event.target.value || null })}><option value="">Choose per generation</option>{profiles.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select></Field><Field label="Instruction"><Select value={draft.defaultInstructionRevisionId ?? ""} onChange={(event) => setDraft({ ...draft, defaultInstructionRevisionId: event.target.value || null })}><option value="">None</option>{instructions.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.revision}</option>)}</Select></Field></div>
      <div className="three-fields"><Field label="Candidates"><Select value={draft.candidateCount} onChange={(event) => setDraft({ ...draft, candidateCount: Number(event.target.value) as 1 | 2 | 3 | 4 })}>{[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}</Select></Field><Field label="Diversity"><Select value={draft.diversity} onChange={(event) => setDraft({ ...draft, diversity: event.target.value as PayloadWorkbenchSettings["diversity"] })}><option value="low">Low</option><option value="balanced">Balanced</option><option value="high">High</option></Select></Field><Field label="Context mode"><Select value={draft.contextMode} onChange={(event) => { const contextMode = event.target.value as PayloadWorkbenchSettings["contextMode"]; setDraft({ ...draft, contextMode, ...(contextMode === "minimal" ? { includeTargetConfig: false } : contextMode === "full" ? { includeTargetConfig: true } : {}) }); }}><option value="none">None</option><option value="minimal">Minimal</option><option value="full">Full</option></Select></Field></div>
      <div className="payload-settings-switches"><label><input type="checkbox" checked={draft.includeProjectBrief} onChange={(event) => setDraft({ ...draft, includeProjectBrief: event.target.checked })} />Project brief</label><label><input type="checkbox" checked={draft.includeSessionBrief} onChange={(event) => setDraft({ ...draft, includeSessionBrief: event.target.checked })} />Session brief</label><label><input type="checkbox" checked={draft.includeTargetConfig} onChange={(event) => setDraft({ ...draft, includeTargetConfig: event.target.checked })} />Target configuration</label></div>
      <Field label="Context budget" hint={`${draft.budgetChars.toLocaleString()} characters · approximately ${Math.ceil(draft.budgetChars / 4).toLocaleString()} tokens`}><div className="payload-budget-control"><input aria-label="Default context budget slider" type="range" min="2000" max="200000" step="1000" value={draft.budgetChars} onChange={(event) => setDraft({ ...draft, budgetChars: Number(event.target.value) })} /><Input aria-label="Exact default context budget" type="number" min="2000" max="200000" step="1000" value={draft.budgetChars} onChange={(event) => setDraft({ ...draft, budgetChars: Number(event.target.value) })} /></div></Field>
      {save.error && <div className="form-error">{save.error.message}</div>}
      <div className="payload-default-actions"><Button type="button" variant="secondary" onClick={() => setDraft(defaultPayloadWorkbenchSettings)}><RotateCcw size={13} /> Reset</Button><Button disabled={save.isPending}><Save size={13} /> {save.isPending ? "Saving…" : "Save defaults"}</Button></div>
    </form>
  </div>;
}

function SettingsLibraryLayout({ title, description, list, editor }: { title: string; description: string; list: ReactNode; editor: ReactNode }) {
  return <div className="payload-settings-library"><section><header><h3>{title}</h3><p>{description}</p></header>{list}</section><aside>{editor}</aside></div>;
}

function EditorHeading({ editing, onCancel, children }: { editing: PayloadAssetRevision | null; onCancel(): void; children: ReactNode }) {
  return <div className="payload-editor-heading"><strong>{editing ? `New revision of ${editing.name}` : `New ${children}`}</strong>{editing && <Button type="button" variant="ghost" aria-label="Cancel editing" onClick={onCancel}><X size={13} /></Button>}</div>;
}

export function PayloadWorkbenchSettingsDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("profiles");
  const settingsQuery = useQuery({ queryKey: ["payload-workbench", "settings"], queryFn: () => api<{ settings: unknown }>("/api/payload-workbench/settings"), enabled: open });
  const providersQuery = useQuery({ queryKey: ["providers", "payload-generator"], queryFn: () => api<{ providers: SafeProvider[] }>("/api/providers?includeArchived=true"), enabled: open });
  const profiles = usePayloadAssets("payload-generator-profile", open);
  const instructions = usePayloadAssets("payload-generator-instruction", open);
  const techniques = usePayloadAssets("payload-technique", open);
  const pipelines = usePayloadAssets("payload-pipeline", open);
  const normalizedSettings = useMemo(() => normalizePayloadWorkbenchSettings(settingsQuery.data?.settings), [settingsQuery.data]);
  const profileRevisions = orderedRevisions(profiles.data?.assets ?? []);
  const instructionRevisions = orderedRevisions(instructions.data?.assets ?? []);
  const techniqueRevisions = orderedRevisions(techniques.data?.assets ?? []);
  const pipelineRevisions = orderedRevisions(pipelines.data?.assets ?? []);
  const loading = settingsQuery.isLoading || providersQuery.isLoading || profiles.isLoading || instructions.isLoading || techniques.isLoading || pipelines.isLoading;
  const queryError = settingsQuery.error ?? providersQuery.error ?? profiles.error ?? instructions.error ?? techniques.error ?? pipelines.error;

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="icon-button payload-settings-trigger" aria-label="Payload Workbench settings" title="Payload Workbench settings"><WandSparkles size={17} /></button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content payload-settings-dialog">
      <div className="payload-settings-heading"><span><WandSparkles size={18} /></span><div><Dialog.Title>Payload Workbench settings</Dialog.Title><Dialog.Description>Reusable generator profiles, instructions, techniques, transform pipelines, and defaults.</Dialog.Description></div></div>
      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as SettingsTab)} className="payload-settings-tabs">
        <Tabs.List><Tabs.Trigger value="profiles"><Sparkles size={13} /> Profiles</Tabs.Trigger><Tabs.Trigger value="instructions"><FileText size={13} /> Instructions</Tabs.Trigger><Tabs.Trigger value="techniques"><FlaskConical size={13} /> Techniques</Tabs.Trigger><Tabs.Trigger value="pipelines"><Braces size={13} /> Pipelines</Tabs.Trigger><Tabs.Trigger value="defaults"><Gauge size={13} /> Defaults</Tabs.Trigger></Tabs.List>
        <div className="payload-settings-content">
          {loading && <div className="payload-settings-loading"><span className="spinner" /> Loading libraries…</div>}
          {queryError && <div className="form-error">{queryError.message}</div>}
          {!loading && <>
            <Tabs.Content value="profiles"><GeneratorProfilesPanel assets={profileRevisions} providers={providersQuery.data?.providers ?? []} /></Tabs.Content>
            <Tabs.Content value="instructions"><TextAssetPanel kind="payload-generator-instruction" noun="instruction" assets={instructionRevisions} /></Tabs.Content>
            <Tabs.Content value="techniques"><TextAssetPanel kind="payload-technique" noun="technique" assets={techniqueRevisions} /></Tabs.Content>
            <Tabs.Content value="pipelines"><PipelinePanel assets={pipelineRevisions} /></Tabs.Content>
            <Tabs.Content value="defaults"><DefaultsPanel settings={normalizedSettings} profiles={profileRevisions} instructions={instructionRevisions} /></Tabs.Content>
          </>}
        </div>
      </Tabs.Root>
      <Dialog.Close className="dialog-close" aria-label="Close Payload Workbench settings"><X size={17} /></Dialog.Close>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
