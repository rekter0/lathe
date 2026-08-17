import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Braces, Check, CopyPlus, FileText, FlaskConical, Library, Search, ShieldCheck, ShieldQuestion, Sparkles } from "lucide-react";
import type { JsonObject, JsonValue } from "@lathe/domain";
import { payloadTransforms, type PayloadTransformDefinition } from "@lathe/payloads";
import { api, jsonBody } from "../api.js";
import type { PayloadAssetRevision } from "../payload-workbench-api.js";
import { Button, Field, Input, Select } from "./forms.js";
import { useOperatorDialog } from "./operator-dialog.js";

type ArsenalKind = "transform" | "profile" | "instruction" | "technique" | "pipeline";
type KindFilter = "all" | ArsenalKind;
type StateFilter = "all" | "active" | "archived";
type TrustFilter = "all" | "trusted" | "untrusted";
type RevisionFilter = "all" | "current" | "historical";

interface TransformEntry {
  key: string;
  kind: "transform";
  name: string;
  description: string;
  tags: readonly string[];
  transform: PayloadTransformDefinition;
  searchable: string;
}

interface AssetEntry {
  key: string;
  kind: Exclude<ArsenalKind, "transform">;
  name: string;
  description: string;
  tags: readonly string[];
  asset: PayloadAssetRevision;
  current: boolean;
  searchable: string;
}

type ArsenalEntry = TransformEntry | AssetEntry;

export interface PayloadArsenalProps {
  profiles: PayloadAssetRevision[];
  instructions: PayloadAssetRevision[];
  techniques: PayloadAssetRevision[];
  pipelines: PayloadAssetRevision[];
  selectedTransformId: string;
  selectedProfileRevisionId: string;
  selectedInstructionRevisionId: string;
  selectedTechniqueRevisionIds: string[];
  selectedPipelineRevisionId: string;
  loading: boolean;
  error: string | undefined;
  onSelectTransform(transform: PayloadTransformDefinition): void;
  onSelectProfile(asset: PayloadAssetRevision): void;
  onSelectInstruction(asset: PayloadAssetRevision): void;
  onSelectTechnique(asset: PayloadAssetRevision): void;
  onSelectPipeline(asset: PayloadAssetRevision): void;
}

const kindLabels: Record<ArsenalKind, string> = {
  transform: "Transform",
  profile: "Generator profile",
  instruction: "Instruction",
  technique: "Technique",
  pipeline: "Pipeline"
};

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function assetKind(kind: PayloadAssetRevision["kind"]): AssetEntry["kind"] {
  if (kind === "payload-generator-profile") return "profile";
  if (kind === "payload-generator-instruction") return "instruction";
  if (kind === "payload-technique") return "technique";
  return "pipeline";
}

function assetSearchFields(asset: PayloadAssetRevision): string[] {
  const value = record(asset.value);
  if (asset.kind === "payload-generator-profile") {
    const backend = record(value.backend);
    return [text(backend.kind), text(backend.modelId), text(backend.providerProfileRevisionId), text(backend.workspaceAccess), text(backend.effort)];
  }
  if (asset.kind === "payload-pipeline") {
    const steps = Array.isArray(value.steps) ? value.steps : [];
    return steps.flatMap((item) => {
      const step = record(item);
      return [text(step.transformId), typeof step.version === "number" ? String(step.version) : ""];
    });
  }
  // Reusable prompt bodies are deliberately inspectable but not included in
  // broad search indexes, which keeps accidental sensitive matches out of view.
  return [];
}

function buildEntries(profiles: PayloadAssetRevision[], instructions: PayloadAssetRevision[], techniques: PayloadAssetRevision[], pipelines: PayloadAssetRevision[]): ArsenalEntry[] {
  const assets = [...profiles, ...instructions, ...techniques, ...pipelines];
  const heads = new Map<string, number>();
  for (const asset of assets) {
    if (!asset.archivedAt) heads.set(asset.assetId, Math.max(heads.get(asset.assetId) ?? 0, asset.revision));
  }
  const transforms: TransformEntry[] = payloadTransforms.map((transform) => ({
    key: `transform:${transform.id}:v${transform.version}`,
    kind: "transform",
    name: transform.label,
    description: transform.description,
    tags: transform.tags,
    transform,
    searchable: [
      transform.id,
      transform.label,
      transform.description,
      transform.group,
      transform.category,
      ...transform.tags,
      ...transform.compatibility,
      ...transform.riskFlags,
      ...transform.warnings.flatMap((warning) => [warning.code, warning.message, warning.severity])
    ].join(" ").toLocaleLowerCase()
  }));
  const revisions: AssetEntry[] = assets.map((asset) => ({
    key: `${assetKind(asset.kind)}:${asset.id}`,
    kind: assetKind(asset.kind),
    name: asset.name,
    description: asset.description,
    tags: asset.tags,
    asset,
    current: heads.get(asset.assetId) === asset.revision,
    searchable: [asset.id, asset.assetId, asset.contentHash, asset.name, asset.description, ...asset.tags, ...assetSearchFields(asset)].join(" ").toLocaleLowerCase()
  }));
  return [...transforms, ...revisions].toSorted((left, right) => {
    const primary = left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);
    if (primary !== 0 || left.kind === "transform" || right.kind === "transform") return primary;
    return right.asset.revision - left.asset.revision;
  });
}

function EntryIcon({ kind }: { kind: ArsenalKind }) {
  if (kind === "transform") return <Braces size={14} />;
  if (kind === "profile") return <Sparkles size={14} />;
  if (kind === "instruction") return <FileText size={14} />;
  if (kind === "technique") return <FlaskConical size={14} />;
  return <Library size={14} />;
}

function Badges({ entry }: { entry: ArsenalEntry }) {
  if (entry.kind === "transform") return <div className="payload-arsenal-badges"><span>built-in</span><span>v{entry.transform.version}</span><span>{entry.transform.group}</span></div>;
  return <div className="payload-arsenal-badges">
    <span>r{entry.asset.revision}</span>
    <span>{entry.current ? "current" : "historical"}</span>
    <span className={entry.asset.trusted ? "trusted" : "untrusted"}>{entry.asset.trusted ? <ShieldCheck size={10} /> : <ShieldQuestion size={10} />}{entry.asset.trusted ? "trusted" : "untrusted"}</span>
    {entry.asset.archivedAt && <span className="archived"><Archive size={10} />archived</span>}
  </div>;
}

function Tags({ values, label }: { values: readonly string[]; label: string }) {
  if (values.length === 0) return null;
  return <div className="payload-arsenal-tags" aria-label={label}>{values.map((value) => <span key={value}>{value}</span>)}</div>;
}

function TransformDetails({ transform }: { transform: PayloadTransformDefinition }) {
  return <>
    <dl className="payload-arsenal-metadata">
      <dt>Registry identity</dt><dd><code>{transform.id}@{transform.version}</code></dd>
      <dt>Data shape</dt><dd>{transform.inputKind} → {transform.outputKind}</dd>
      <dt>Behavior</dt><dd>{transform.deterministic ? "deterministic" : "non-deterministic"} · {transform.lossiness}</dd>
      <dt>Expansion</dt><dd>{transform.expansion.summary}</dd>
      <dt>Inverse</dt><dd>{transform.inverseTransformId ?? "Not available"}</dd>
    </dl>
    <Tags values={transform.tags} label="Transform tags" />
    <section><h4>Compatibility</h4><Tags values={transform.compatibility} label="Compatibility flags" />{transform.compatibility.length === 0 && <p>None declared.</p>}</section>
    {transform.riskFlags.length > 0 && <section><h4>Risk flags</h4><Tags values={transform.riskFlags} label="Risk flags" /></section>}
    <section><h4>Parameters</h4>{transform.parameterSchema.mode === "variables" ? <p>Consumes the workbench variable overrides.</p> : transform.parameterSchema.fields.length === 0 ? <p>No parameters.</p> : <dl className="payload-arsenal-parameters">{transform.parameterSchema.fields.map((field) => <div key={field.name}><dt>{field.label}</dt><dd><code>{field.name}</code> · {field.type}{field.required ? " · required" : ""}{field.defaultValue !== undefined ? ` · default ${field.defaultValue}` : ""}<small>{field.description}</small></dd></div>)}</dl>}</section>
    {transform.warnings.length > 0 && <section><h4>Warnings</h4>{transform.warnings.map((warning) => <p className={`payload-transform-warning ${warning.severity}`} key={warning.code}>{warning.message}</p>)}</section>}
  </>;
}

function InstructionDetails({ asset }: { asset: PayloadAssetRevision }) {
  const value = record(asset.value);
  return <section><h4>Instruction template</h4><pre>{text(value.template) || "No template text."}</pre></section>;
}

function TechniqueDetails({ asset }: { asset: PayloadAssetRevision }) {
  const value = record(asset.value);
  const constraints = [
    ["Conflicts with", strings(value.conflictsWith)],
    ["Before", strings(value.before)],
    ["After", strings(value.after)]
  ] as const;
  return <><section><h4>Technique instructions</h4><pre>{text(value.instructions) || "No technique instructions."}</pre></section>{constraints.some(([, values]) => values.length > 0) && <section><h4>Ordering and conflicts</h4><dl className="payload-arsenal-constraints">{constraints.filter(([, values]) => values.length > 0).map(([label, values]) => <div key={label}><dt>{label}</dt><dd>{values.map((value) => <code key={value}>{value}</code>)}</dd></div>)}</dl></section>}</>;
}

function ProfileDetails({ asset }: { asset: PayloadAssetRevision }) {
  const value = record(asset.value);
  const backend = record(value.backend);
  return <section><h4>Generator backend</h4><dl className="payload-arsenal-metadata">
    <dt>Backend</dt><dd>{text(backend.kind) || "Unknown"}</dd>
    <dt>Model</dt><dd><code>{text(backend.modelId) || "Not configured"}</code></dd>
    {text(backend.providerProfileRevisionId) && <><dt>Provider revision</dt><dd><code>{text(backend.providerProfileRevisionId)}</code></dd></>}
    {text(backend.effort) && <><dt>Reasoning effort</dt><dd>{text(backend.effort)}</dd></>}
    {text(backend.workspaceAccess) && <><dt>Workspace access</dt><dd>{text(backend.workspaceAccess)}</dd></>}
    {typeof backend.reasoning === "boolean" && <><dt>Reasoning capture</dt><dd>{backend.reasoning ? "enabled" : "disabled"}</dd></>}
  </dl></section>;
}

function pipelineIssues(asset: PayloadAssetRevision): string[] {
  const value = record(asset.value);
  const steps = Array.isArray(value.steps) ? value.steps : [];
  return steps.flatMap((item, index) => {
    const step = record(item);
    const transformId = text(step.transformId) || text(step.id);
    const transform = payloadTransforms.find((candidate) => candidate.id === transformId);
    if (!transform) return [`Step ${index + 1} references unknown transform “${transformId || "missing"}”.`];
    if (step.version !== transform.version) return [`Step ${index + 1} requires ${transformId}@${String(step.version ?? "missing")}; this build supports @${transform.version}.`];
    return [];
  });
}

function PipelineDetails({ asset }: { asset: PayloadAssetRevision }) {
  const value = record(asset.value);
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const issues = pipelineIssues(asset);
  return <section><h4>Ordered steps</h4>{issues.length > 0 && <div className="payload-arsenal-incompatible" role="status"><strong>Incompatible with this transform registry</strong>{issues.map((issue) => <p key={issue}>{issue}</p>)}</div>}{steps.length === 0 ? <p>No steps.</p> : <ol className="payload-arsenal-pipeline">{steps.map((item, index) => {
    const step = record(item);
    const transformId = text(step.transformId) || text(step.id);
    const transform = payloadTransforms.find((candidate) => candidate.id === transformId);
    const incompatible = !transform || step.version !== transform.version;
    return <li key={`${transformId}:${index}`} className={`${step.enabled === false ? "disabled " : ""}${incompatible ? "incompatible" : ""}`.trim()}><strong>{transform?.label ?? (transformId || "Unknown transform")}</strong><code>{transformId || "missing"}@{typeof step.version === "number" ? step.version : "missing"}</code>{step.enabled === false && <span>disabled</span>}{incompatible && <span>incompatible</span>}{step.parameters !== undefined && <pre>{JSON.stringify(step.parameters, null, 2)}</pre>}</li>;
  })}</ol>}</section>;
}

function AssetDetails({ entry }: { entry: AssetEntry }) {
  return <>
    <dl className="payload-arsenal-metadata">
      <dt>Exact revision</dt><dd><code>{entry.asset.id}</code></dd>
      <dt>Asset</dt><dd><code>{entry.asset.assetId}</code></dd>
      <dt>Content hash</dt><dd><code>{entry.asset.contentHash}</code></dd>
      <dt>Created</dt><dd>{new Date(entry.asset.createdAt).toLocaleString()}</dd>
      {entry.asset.archivedAt && <><dt>Archived</dt><dd>{new Date(entry.asset.archivedAt).toLocaleString()}</dd></>}
    </dl>
    <Tags values={entry.tags} label={`${kindLabels[entry.kind]} tags`} />
    {entry.kind === "profile" ? <ProfileDetails asset={entry.asset} /> : entry.kind === "instruction" ? <InstructionDetails asset={entry.asset} /> : entry.kind === "technique" ? <TechniqueDetails asset={entry.asset} /> : <PipelineDetails asset={entry.asset} />}
  </>;
}

function jsonPreview(value: JsonValue): { text: string; truncated: boolean } {
  const serialized = JSON.stringify(value, null, 2);
  const maximum = 20_000;
  return serialized.length > maximum ? { text: serialized.slice(0, maximum), truncated: true } : { text: serialized, truncated: false };
}

function RevisionComparison({ left, right }: { left: PayloadAssetRevision; right: PayloadAssetRevision }) {
  const leftPreview = jsonPreview(left.value);
  const rightPreview = jsonPreview(right.value);
  return <div className="payload-arsenal-comparison" aria-label="Same-lineage revision comparison"><article><h5>{left.name} · r{left.revision}</h5><small>{left.contentHash}</small><pre>{leftPreview.text}</pre>{leftPreview.truncated && <p>Preview truncated at 20,000 UTF-16 code units. The content hash above identifies the exact value.</p>}</article><article><h5>{right.name} · r{right.revision}</h5><small>{right.contentHash}</small><pre>{rightPreview.text}</pre>{rightPreview.truncated && <p>Preview truncated at 20,000 UTF-16 code units. The content hash above identifies the exact value.</p>}</article></div>;
}

export function PayloadArsenal({ profiles, instructions, techniques, pipelines, selectedTransformId, selectedProfileRevisionId, selectedInstructionRevisionId, selectedTechniqueRevisionIds, selectedPipelineRevisionId, loading, error, onSelectTransform, onSelectProfile, onSelectInstruction, onSelectTechnique, onSelectPipeline }: PayloadArsenalProps) {
  const queryClient = useQueryClient();
  const dialogs = useOperatorDialog();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [category, setCategory] = useState("all");
  const [tag, setTag] = useState("all");
  const [compatibility, setCompatibility] = useState("all");
  const [state, setState] = useState<StateFilter>("active");
  const [trust, setTrust] = useState<TrustFilter>("all");
  const [revision, setRevision] = useState<RevisionFilter>("all");
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const [compareRevisionId, setCompareRevisionId] = useState("");
  const [cloneMessage, setCloneMessage] = useState<string | null>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const entries = useMemo(() => buildEntries(profiles, instructions, techniques, pipelines), [profiles, instructions, techniques, pipelines]);
  const tags = useMemo(() => [...new Set(entries.flatMap((entry) => [...entry.tags]))].toSorted((left, right) => left.localeCompare(right)), [entries]);
  const compatibilities = useMemo(() => [...new Set(payloadTransforms.flatMap((transform) => [...transform.compatibility]))].toSorted((left, right) => left.localeCompare(right)), []);
  const clone = useMutation({
    mutationFn: ({ asset, name }: { asset: PayloadAssetRevision; name: string }) => api<{ asset: PayloadAssetRevision }>("/api/library/assets", {
      method: "POST",
      ...jsonBody({ kind: asset.kind, name, description: asset.description, tags: asset.tags, provenance: { operatorAuthored: true, clonedFromRevisionId: asset.id }, value: asset.value, trusted: asset.trusted })
    }),
    onSuccess: ({ asset }) => {
      setCloneMessage(`Created “${asset.name}” at exact revision ${asset.id}.`);
      void queryClient.invalidateQueries({ queryKey: ["assets", asset.kind] });
    },
    onError: (cloneError) => setCloneMessage(cloneError.message)
  });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const results = entries.filter((entry) => {
    if (kind !== "all" && entry.kind !== kind) return false;
    if (normalizedQuery && !entry.searchable.includes(normalizedQuery)) return false;
    if (tag !== "all" && !entry.tags.includes(tag)) return false;
    if (category !== "all" && (entry.kind !== "transform" || entry.transform.category !== category)) return false;
    if (compatibility !== "all" && (entry.kind !== "transform" || !entry.transform.compatibility.some((value) => value === compatibility))) return false;
    const archived = entry.kind !== "transform" && Boolean(entry.asset.archivedAt);
    if (state === "active" && archived) return false;
    if (state === "archived" && !archived) return false;
    const trusted = entry.kind === "transform" || entry.asset.trusted;
    if (trust === "trusted" && !trusted) return false;
    if (trust === "untrusted" && trusted) return false;
    const current = entry.kind === "transform" || entry.current;
    if (revision === "current" && !current) return false;
    if (revision === "historical" && current) return false;
    return true;
  });
  const inspected = results.find((entry) => entry.key === inspectedKey) ?? results[0] ?? null;
  const inspectedAsset = inspected && inspected.kind !== "transform" ? inspected : null;
  const siblingEntries = inspectedAsset ? entries.filter((entry): entry is AssetEntry => entry.kind !== "transform" && entry.asset.assetId === inspectedAsset.asset.assetId && entry.asset.id !== inspectedAsset.asset.id).toSorted((left, right) => Math.abs(left.asset.revision - inspectedAsset.asset.revision) - Math.abs(right.asset.revision - inspectedAsset.asset.revision) || right.asset.revision - left.asset.revision) : [];
  const compareEntry = siblingEntries.find((entry) => entry.asset.id === compareRevisionId) ?? siblingEntries[0] ?? null;
  const selectKind = (next: KindFilter) => {
    setKind(next);
    if (next !== "all" && next !== "transform") {
      setCategory("all");
      setCompatibility("all");
    }
  };
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target = index;
    if (event.key === "ArrowDown") target = Math.min(results.length - 1, index + 1);
    else if (event.key === "ArrowUp") target = Math.max(0, index - 1);
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = results.length - 1;
    else return;
    event.preventDefault();
    resultRefs.current[target]?.focus();
  };
  const actionSelected = inspected?.kind === "transform"
    ? selectedTransformId === inspected.transform.id
    : inspected?.kind === "profile" ? selectedProfileRevisionId === inspected.asset.id
      : inspected?.kind === "instruction" ? selectedInstructionRevisionId === inspected.asset.id
        : inspected?.kind === "technique" ? selectedTechniqueRevisionIds.includes(inspected.asset.id)
          : inspected?.kind === "pipeline" ? selectedPipelineRevisionId === inspected.asset.id : false;
  const actionDisabledReason = inspected?.kind === "transform" ? null
    : inspected?.asset.archivedAt ? "Archived revisions remain inspectable but cannot be selected for new work."
      : inspected && !inspected.asset.trusted ? "Untrusted revisions remain inspectable but cannot be selected for execution."
        : inspected?.kind === "pipeline" && pipelineIssues(inspected.asset).length > 0 ? "This pipeline references transforms or versions unavailable in this build."
          : null;
  const selectInspected = () => {
    if (!inspected) return;
    if (inspected.kind === "transform") onSelectTransform(inspected.transform);
    else if (inspected.kind === "profile") onSelectProfile(inspected.asset);
    else if (inspected.kind === "instruction") onSelectInstruction(inspected.asset);
    else if (inspected.kind === "technique") onSelectTechnique(inspected.asset);
    else onSelectPipeline(inspected.asset);
  };
  const cloneInspected = async () => {
    if (!inspected || inspected.kind === "transform") return;
    const name = await dialogs.prompt({
      title: `Clone ${kindLabels[inspected.kind].toLocaleLowerCase()}`,
      description: `Create a new independent item from exact revision r${inspected.asset.revision}. Trust state is preserved.`,
      label: "New item name",
      defaultValue: `${inspected.asset.name} copy`,
      confirmLabel: "Clone as new item"
    });
    if (!name?.trim()) return;
    setCloneMessage(null);
    clone.mutate({ asset: inspected.asset, name: name.trim() });
  };
  return <div className="payload-arsenal">
    <header className="payload-arsenal-heading"><div><Library size={17} /><span><strong>Searchable arsenal</strong><small>Inspect exact immutable revisions, then explicitly select one for Transform or Generate.</small></span></div><output aria-live="polite">{results.length} of {entries.length}</output></header>
    <section className="payload-arsenal-filters" aria-label="Arsenal filters">
      <Field label="Search"><div className="payload-arsenal-search"><Search size={13} /><Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, ID, tag, backend…" /></div></Field>
      <Field label="Kind"><Select value={kind} onChange={(event) => selectKind(event.target.value as KindFilter)}><option value="all">All kinds</option><option value="transform">Transforms</option><option value="profile">Generator profiles</option><option value="instruction">Instructions</option><option value="technique">Techniques</option><option value="pipeline">Pipelines</option></Select></Field>
      {(kind === "all" || kind === "transform") && <Field label="Category"><Select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{[...new Set(payloadTransforms.map((transform) => transform.category))].map((value) => <option value={value} key={value}>{value}</option>)}</Select></Field>}
      <Field label="Tag"><Select value={tag} onChange={(event) => setTag(event.target.value)}><option value="all">All tags</option>{tags.map((value) => <option value={value} key={value}>{value}</option>)}</Select></Field>
      {(kind === "all" || kind === "transform") && <Field label="Compatibility"><Select value={compatibility} onChange={(event) => setCompatibility(event.target.value)}><option value="all">Any compatibility</option>{compatibilities.map((value) => <option value={value} key={value}>{value}</option>)}</Select></Field>}
      <Field label="State"><Select value={state} onChange={(event) => setState(event.target.value as StateFilter)}><option value="active">Active</option><option value="all">Active and archived</option><option value="archived">Archived only</option></Select></Field>
      <Field label="Revisions"><Select value={revision} onChange={(event) => setRevision(event.target.value as RevisionFilter)}><option value="all">All revisions</option><option value="current">Current revisions</option><option value="historical">Historical revisions</option></Select></Field>
      <Field label="Trust"><Select value={trust} onChange={(event) => setTrust(event.target.value as TrustFilter)}><option value="all">Any trust</option><option value="trusted">Trusted / built-in</option><option value="untrusted">Untrusted</option></Select></Field>
    </section>
    <div className="payload-arsenal-messages">
      {loading && <div className="payload-arsenal-notice" role="status"><span className="spinner small" /> Loading complete revision libraries…</div>}
      {error && <div className="form-error" role="alert">Arsenal libraries could not be loaded: {error}</div>}
    </div>
    <div className="payload-arsenal-layout">
      <section className="payload-arsenal-results" aria-label="Arsenal results">
        {results.length === 0 && <p className="payload-arsenal-empty">No arsenal entries match these filters.</p>}
        {results.map((entry, index) => <button type="button" className="payload-arsenal-result" aria-pressed={inspected?.key === entry.key} onClick={() => setInspectedKey(entry.key)} onKeyDown={(event) => moveFocus(event, index)} ref={(node) => { resultRefs.current[index] = node; }} key={entry.key}><span className="payload-arsenal-result-icon"><EntryIcon kind={entry.kind} /></span><span><span><strong>{entry.name}</strong><small>{kindLabels[entry.kind]}</small></span><p>{entry.description || "No description"}</p><Badges entry={entry} /></span></button>)}
      </section>
      <aside className="payload-arsenal-inspector" aria-label="Arsenal entry details">
        {!inspected ? <p className="payload-arsenal-empty">Choose an entry to inspect it.</p> : <><header><div><EntryIcon kind={inspected.kind} /><span><small>{kindLabels[inspected.kind]}</small><h3>{inspected.name}</h3></span></div><Badges entry={inspected} /></header><p>{inspected.description || "No description"}</p>{inspected.kind === "transform" ? <TransformDetails transform={inspected.transform} /> : <><AssetDetails entry={inspected} />{compareEntry && <section className="payload-arsenal-compare"><h4>Compare same-lineage revision</h4><Field label="Compare with revision"><Select value={compareEntry.asset.id} onChange={(event) => setCompareRevisionId(event.target.value)}>{siblingEntries.map((entry) => <option value={entry.asset.id} key={entry.asset.id}>r{entry.asset.revision} · {entry.asset.id}{entry.asset.archivedAt ? " · archived" : ""}</option>)}</Select></Field><RevisionComparison left={inspected.asset} right={compareEntry.asset} /></section>}</>}<footer><div>{inspected.kind !== "transform" && <Button type="button" variant="secondary" disabled={clone.isPending} onClick={() => void cloneInspected()}><CopyPlus size={13} /> {clone.isPending ? "Cloning…" : "Clone as new item"}</Button>}<Button type="button" disabled={actionSelected || Boolean(actionDisabledReason)} onClick={selectInspected}>{actionSelected ? <><Check size={13} /> Selected</> : inspected.kind === "profile" ? "Select exact profile" : inspected.kind === "technique" ? "Add exact technique" : inspected.kind === "instruction" ? "Select exact instruction" : inspected.kind === "pipeline" ? "Select exact pipeline" : "Select transform"}</Button></div>{actionDisabledReason && <small>{actionDisabledReason}</small>}{cloneMessage && <small role="status">{cloneMessage}</small>}</footer></>}
      </aside>
    </div>
  </div>;
}
