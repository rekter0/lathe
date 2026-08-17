import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, BookOpen, Braces, Check, CopyPlus, Eye, FileText, FlaskConical, Library, ListRestart, Search, ShieldCheck, ShieldQuestion, Sparkles } from "lucide-react";
import type { JsonObject, JsonValue } from "@lathe/domain";
import { payloadTransforms, type PayloadTransformDefinition } from "@lathe/payloads";
import { ApiError, api, jsonBody } from "../api.js";
import type { PayloadAssetRevision, PayloadRecipePreview, PayloadRecipeReplayResult, PayloadRevision } from "../payload-workbench-api.js";
import { Button, Field, Input, Select } from "./forms.js";
import { useOperatorDialog } from "./operator-dialog.js";

type ArsenalKind = "transform" | "profile" | "instruction" | "technique" | "pipeline" | "recipe";
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
  recipes: PayloadAssetRevision[];
  sessionId: string | null;
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
  onReplayRecipe(revision: PayloadRevision, warning?: string): void;
}

const kindLabels: Record<ArsenalKind, string> = {
  transform: "Transform",
  profile: "Generator profile",
  instruction: "Instruction",
  technique: "Technique",
  pipeline: "Pipeline",
  recipe: "Recipe"
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

function resourceReferences(error: Error | null): Array<{ kind: string; label: string; detail: string }> {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object" || Array.isArray(error.details)) return [];
  const body = error.details as Record<string, unknown>;
  if (!body.error || typeof body.error !== "object" || Array.isArray(body.error)) return [];
  const references = (body.error as Record<string, unknown>).references;
  if (!Array.isArray(references)) return [];
  return references.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.kind !== "string" || typeof candidate.label !== "string" || typeof candidate.detail !== "string") return [];
    return [{ kind: candidate.kind, label: candidate.label, detail: candidate.detail }];
  });
}

function assetKind(kind: PayloadAssetRevision["kind"]): AssetEntry["kind"] {
  if (kind === "payload-generator-profile") return "profile";
  if (kind === "payload-generator-instruction") return "instruction";
  if (kind === "payload-technique") return "technique";
  if (kind === "payload-recipe") return "recipe";
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
  if (asset.kind === "payload-recipe") {
    const steps = Array.isArray(value.steps) ? value.steps : [];
    const variables = Array.isArray(value.variables) ? value.variables : [];
    return [
      ...steps.flatMap((item) => {
        const step = record(item);
        const generator = record(step.generator);
        return [text(step.kind), text(step.sourceOperation), text(step.transformId), typeof step.version === "number" ? String(step.version) : "", text(generator.profileRevisionId), text(generator.instructionRevisionId), ...strings(generator.techniqueRevisionIds), text(generator.pipelineRevisionId), text(step.pipelineRevisionId)];
      }),
      ...variables.map((item) => text(record(item).name))
    ];
  }
  // Reusable prompt bodies are deliberately inspectable but not included in
  // broad search indexes, which keeps accidental sensitive matches out of view.
  return [];
}

function buildEntries(profiles: PayloadAssetRevision[], instructions: PayloadAssetRevision[], techniques: PayloadAssetRevision[], pipelines: PayloadAssetRevision[], recipes: PayloadAssetRevision[]): ArsenalEntry[] {
  const assets = [...profiles, ...instructions, ...techniques, ...pipelines, ...recipes];
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
  if (kind === "recipe") return <BookOpen size={14} />;
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

function recipeVariables(asset: PayloadAssetRevision): Array<{ name: string; defaultValue: string | null }> {
  const variables = record(asset.value).variables;
  if (!Array.isArray(variables)) return [];
  return variables.flatMap((item) => {
    const variable = record(item);
    const name = text(variable.name);
    if (!name) return [];
    return [{ name, defaultValue: typeof variable.defaultValue === "string" ? variable.defaultValue : null }];
  });
}

function recipeDependencies(asset: PayloadAssetRevision): Array<{ assetRevisionId: string; assetKind: string; role: string; stepIndex: number }> {
  return recipeSteps(asset).flatMap((step, stepIndex) => {
    if (step.kind === "transform") {
      const pipelineRevisionId = text(step.pipelineRevisionId);
      return pipelineRevisionId ? [{ assetRevisionId: pipelineRevisionId, assetKind: "payload-pipeline", role: "pipeline", stepIndex }] : [];
    }
    const generator = record(step.generator);
    if (Object.keys(generator).length === 0) return [];
    return [
      ...(text(generator.profileRevisionId) ? [{ assetRevisionId: text(generator.profileRevisionId), assetKind: "payload-generator-profile", role: "generator profile", stepIndex }] : []),
      ...(text(generator.instructionRevisionId) ? [{ assetRevisionId: text(generator.instructionRevisionId), assetKind: "payload-generator-instruction", role: "generator instruction", stepIndex }] : []),
      ...strings(generator.techniqueRevisionIds).map((assetRevisionId) => ({ assetRevisionId, assetKind: "payload-technique", role: "technique", stepIndex })),
      ...(text(generator.pipelineRevisionId) ? [{ assetRevisionId: text(generator.pipelineRevisionId), assetKind: "payload-pipeline", role: "pipeline", stepIndex }] : [])
    ];
  });
}

function recipeSteps(asset: PayloadAssetRevision): JsonObject[] {
  const steps = record(asset.value).steps;
  return Array.isArray(steps) ? steps.flatMap((item) => {
    const step = record(item);
    return Object.keys(step).length > 0 ? [step] : [];
  }) : [];
}

function recipeStaticIssues(asset: PayloadAssetRevision, knownAssetRevisionIds: Set<string>): string[] {
  const value = record(asset.value);
  const issues: string[] = [];
  if (value.version !== 1) issues.push(`Recipe format version ${String(value.version ?? "missing")} is unsupported.`);
  recipeSteps(asset).forEach((step, index) => {
    const kind = text(step.kind);
    if (kind === "checkpoint") return;
    if (kind !== "transform") {
      issues.push(`Step ${index + 1} has unknown kind “${kind || "missing"}”.`);
      return;
    }
    const transformId = text(step.transformId);
    const transform = payloadTransforms.find((candidate) => candidate.id === transformId);
    if (!transform) issues.push(`Step ${index + 1} requires unavailable transform “${transformId || "missing"}”.`);
    else if (step.version !== transform.version) issues.push(`Step ${index + 1} requires ${transformId}@${String(step.version ?? "missing")}; this build supports @${transform.version}.`);
  });
  for (const dependency of recipeDependencies(asset)) {
    if (!knownAssetRevisionIds.has(dependency.assetRevisionId)) issues.push(`Step ${dependency.stepIndex + 1} is missing exact ${dependency.role} revision ${dependency.assetRevisionId}.`);
  }
  return issues;
}

function RecipeDetails({ asset, knownAssetRevisionIds }: { asset: PayloadAssetRevision; knownAssetRevisionIds: Set<string> }) {
  const value = record(asset.value);
  const variables = recipeVariables(asset);
  const dependencies = recipeDependencies(asset);
  const steps = recipeSteps(asset);
  const issues = recipeStaticIssues(asset, knownAssetRevisionIds);
  return <>
    {issues.length > 0 && <section className="payload-arsenal-incompatible" role="status"><strong>Recipe incompatibilities</strong>{issues.map((issue) => <p key={issue}>{issue}</p>)}</section>}
    <dl className="payload-arsenal-metadata">
      <dt>Recipe format</dt><dd>v{typeof value.version === "number" ? value.version : "unknown"}</dd>
      <dt>Final captured hash</dt><dd><code>{text(value.finalContentHash) || "Missing"}</code></dd>
      <dt>Steps</dt><dd>{steps.length}</dd>
      <dt>Variables</dt><dd>{variables.length}</dd>
      <dt>Dependencies</dt><dd>{dependencies.length}</dd>
    </dl>
    <section><h4>Step manifest</h4>{steps.length === 0 ? <p>No recipe steps.</p> : <ol className="payload-arsenal-recipe-steps">{steps.map((step, index) => {
      const checkpoint = step.kind === "checkpoint";
      const generator = record(step.generator);
      return <li key={`${text(step.kind)}:${index}`}>
        <header><span>{index + 1}</span><strong>{checkpoint ? "Captured checkpoint" : text(step.transformId) || "Unknown transform"}</strong><code>{checkpoint ? text(step.sourceOperation) || "checkpoint" : `@${String(step.version ?? "missing")}`}</code></header>
        {checkpoint ? <dl>
          <dt>Captured hash</dt><dd><code>{text(step.contentHash) || "Missing"}</code></dd>
          {Object.keys(generator).length > 0 && <><dt>Generator profile</dt><dd><code>{text(generator.profileRevisionId) || "Missing"}</code></dd><dt>Context hash</dt><dd><code>{text(generator.contextHash) || "Missing"}</code></dd></>}
        </dl> : <dl>
          <dt>Input hash</dt><dd><code>{text(step.inputContentHash) || "Missing"}</code></dd>
          <dt>Captured hash</dt><dd><code>{text(step.outputContentHash) || "Missing"}</code></dd>
          <dt>Parameters</dt><dd><pre>{JSON.stringify(record(step.parameters), null, 2)}</pre></dd>
        </dl>}
      </li>;
    })}</ol>}</section>
    <section><h4>Exact asset dependencies</h4>{dependencies.length === 0 ? <p>No generator or pipeline assets are required.</p> : <ul className="payload-arsenal-recipe-dependencies">{dependencies.map((dependency, index) => <li key={`${dependency.assetRevisionId}:${index}`}><span>{dependency.role} · step {dependency.stepIndex + 1}</span><code>{dependency.assetRevisionId}</code><small>{dependency.assetKind}</small></li>)}</ul>}</section>
    <section><h4>Variables</h4>{variables.length === 0 ? <p>No variable overrides are required.</p> : <dl className="payload-arsenal-constraints">{variables.map((variable) => <div key={variable.name}><dt><code>{variable.name}</code></dt><dd>{variable.defaultValue === null ? "Required at replay" : <><span>Default</span> <code>{variable.defaultValue}</code></>}</dd></div>)}</dl>}</section>
  </>;
}

function RecipeReplay({ asset, sessionId, archived, trusted, knownAssetRevisionIds, onReplay, onTrusted }: { asset: PayloadAssetRevision; sessionId: string | null; archived: boolean; trusted: boolean; knownAssetRevisionIds: Set<string>; onReplay(revision: PayloadRevision, warning?: string): void; onTrusted(asset: PayloadAssetRevision): void }) {
  const queryClient = useQueryClient();
  const dialogs = useOperatorDialog();
  const definitions = recipeVariables(asset);
  const [variables, setVariables] = useState<Record<string, string>>(() => Object.fromEntries(definitions.map((variable) => [variable.name, variable.defaultValue ?? ""])));
  const [overriddenVariables, setOverriddenVariables] = useState<Set<string>>(() => new Set());
  const requestVariables = Object.fromEntries(definitions.flatMap((definition) => overriddenVariables.has(definition.name)
    ? [[definition.name, variables[definition.name] ?? ""]]
    : []));
  const preview = useMutation({
    mutationFn: () => api<{ preview: PayloadRecipePreview }>(`/api/payload-recipes/${asset.id}/preview`, { method: "POST", ...jsonBody({ sessionId, variables: requestVariables }) })
  });
  const replay = useMutation({
    mutationFn: () => api<PayloadRecipeReplayResult>(`/api/payload-recipes/${asset.id}/replay`, {
      method: "POST",
      ...jsonBody({ sessionId, variables: requestVariables, preflightHash: preview.data?.preview.preflightHash })
    }),
    onSuccess: (response) => {
      if (sessionId) void queryClient.invalidateQueries({ queryKey: ["payload-generations", sessionId] });
      if (response.revision) onReplay(response.revision, response.error ? `Step ${response.error.stepIndex + 1}: ${response.error.message}` : undefined);
    }
  });
  const trust = useMutation({
    mutationFn: () => api<{ asset: PayloadAssetRevision }>("/api/library/assets", {
      method: "POST",
      ...jsonBody({
        assetId: asset.assetId,
        kind: "payload-recipe",
        name: asset.name,
        description: asset.description,
        tags: asset.tags,
        provenance: { ...record(asset.provenance), trustedFromRevisionId: asset.id, operatorTrustedAt: new Date().toISOString() },
        value: asset.value,
        trusted: true
      })
    }),
    onSuccess: ({ asset: trustedAsset }) => {
      void queryClient.invalidateQueries({ queryKey: ["assets", "payload-recipe"] });
      void queryClient.invalidateQueries({ queryKey: ["assets", "payload-recipe", "include-archived"] });
      onTrusted(trustedAsset);
    }
  });
  const result = preview.data?.preview;
  const localIssues = recipeStaticIssues(asset, knownAssetRevisionIds);
  const replayReady = Boolean(result?.compatible && result.completed && result.preflightHash && result.variables.missing.length === 0 && !archived && trusted);
  const updateVariable = (name: string, value: string) => {
    setVariables((current) => ({ ...current, [name]: value }));
    setOverriddenVariables((current) => new Set(current).add(name));
    preview.reset();
    replay.reset();
  };
  const trustRecipe = async () => {
    const approved = await dialogs.confirm({
      title: "Trust this recipe as a new revision?",
      description: "Review the captured checkpoints, exact asset dependencies, transforms, and preview first. Trust creates a new immutable revision; it does not replay the recipe or run any model or target.",
      confirmLabel: "Trust as new revision"
    });
    if (approved) trust.mutate();
  };
  return <section className="payload-recipe-replay" aria-label="Recipe replay">
    <header><div><ListRestart size={14} /><span><strong>Authoritative replay</strong><small>Captured checkpoints are restored exactly; deterministic transforms are rerun and hash-checked.</small></span></div></header>
    {definitions.length > 0 && <fieldset><legend>Replay variables</legend>{definitions.map((definition) => <Field label={definition.name} hint={definition.defaultValue === null ? "Required; no captured default" : `Captured default: ${definition.defaultValue}`} key={definition.name}><Input aria-label={definition.name} value={variables[definition.name] ?? ""} onChange={(event) => updateVariable(definition.name, event.target.value)} /></Field>)}</fieldset>}
    {localIssues.length > 0 && <div className="payload-arsenal-incompatible" role="status"><strong>Local compatibility warnings</strong>{localIssues.map((issue) => <p key={issue}>{issue}</p>)}</div>}
    {!sessionId && <p className="payload-arsenal-incompatible">Open Payload Workbench from a session to preview and replay this recipe.</p>}
    {archived && <p className="payload-arsenal-incompatible">Archived recipe revisions remain inspectable but cannot start a new replay.</p>}
    {!trusted && <div className="payload-arsenal-incompatible"><p>Imported or untrusted recipe revisions can be previewed, but cannot be replayed until the operator trusts a new immutable revision.</p>{!archived && <Button type="button" variant="secondary" disabled={trust.isPending} onClick={() => void trustRecipe()}>{trust.isPending ? "Trusting…" : "Trust as new revision"}</Button>}</div>}
    <div className="payload-recipe-actions"><Button type="button" variant="secondary" disabled={!sessionId || preview.isPending || replay.isPending} onClick={() => preview.mutate()}>{preview.isPending ? <span className="spinner small" /> : <Eye size={13} />} Preview recipe</Button><Button type="button" disabled={!replayReady || replay.isPending} onClick={() => replay.mutate()}><ListRestart size={13} />{replay.isPending ? "Replaying…" : "Replay into Transform"}</Button></div>
    {(preview.error || replay.error || trust.error) && <div className="form-error" role="alert">{preview.error?.message ?? replay.error?.message ?? trust.error?.message}</div>}
    {replay.data?.error && !replay.data.revision && <div className="form-error" role="alert">Replay stopped at step {replay.data.error.stepIndex + 1} before any revision could be restored: {replay.data.error.message}</div>}
    {result && <section className={`payload-recipe-preview${result.compatible ? " compatible" : " incompatible"}`} aria-label="Recipe preview result">
      <header><strong>{result.compatible ? result.completed ? "Compatible preflight" : "Compatible prefix preflight" : "Incompatible preflight"}</strong><span>{result.matchesCaptured ? "Final hash matches captured" : "Final hash differs from captured"}</span></header>
      <dl className="payload-arsenal-metadata"><dt>Recipe hash</dt><dd><code>{result.recipeContentHash}</code></dd><dt>Preflight</dt><dd><code>{result.preflightHash ?? "Unavailable"}</code></dd><dt>Computed final hash</dt><dd><code>{result.finalContentHash}</code></dd><dt>Captured final hash</dt><dd><code>{result.capturedFinalContentHash}</code></dd><dt>Missing variables</dt><dd>{result.variables.missing.length > 0 ? result.variables.missing.map((name) => <code key={name}>{name}</code>) : "None"}</dd></dl>
      {result.compatible && !result.completed && <p className="payload-arsenal-incompatible">Preflight stopped during deterministic evaluation. Replay is disabled; inspect the last successful output and failing step. No helper model was called.</p>}
      {result.violations.length > 0 && <div className="payload-arsenal-incompatible" role="status"><strong>{result.compatible ? "Replay warnings" : "Replay blocked"}</strong>{result.violations.map((violation, index) => <p key={`${violation.code}:${index}`}>{violation.severity} · {violation.stepIndex === null ? "" : `step ${violation.stepIndex + 1} · `}{violation.message}</p>)}</div>}
      <ol>{result.steps.map((step) => <li className={step.matchesCaptured === false ? "mismatch" : "matches"} key={step.index}><header><span>{step.index + 1}</span><strong>{step.kind === "checkpoint" ? `Captured checkpoint · ${step.label}` : step.label}</strong><span>{step.status}</span></header><dl><dt>Computed</dt><dd><code>{step.outputContentHash ?? "Unavailable"}</code></dd><dt>Captured</dt><dd><code>{step.capturedOutputContentHash}</code></dd><dt>Output size</dt><dd>{step.codePoints === null ? "Unavailable" : `${step.codePoints.toLocaleString()} code points${step.textTruncated ? " · preview truncated" : ""}`}</dd></dl>{step.error && <p>{step.error}</p>}<details><summary>Inspect output</summary><pre>{step.text}</pre></details></li>)}</ol>
    </section>}
  </section>;
}

function AssetDetails({ entry, knownAssetRevisionIds }: { entry: AssetEntry; knownAssetRevisionIds: Set<string> }) {
  return <>
    <dl className="payload-arsenal-metadata">
      <dt>Exact revision</dt><dd><code>{entry.asset.id}</code></dd>
      <dt>Asset</dt><dd><code>{entry.asset.assetId}</code></dd>
      <dt>Content hash</dt><dd><code>{entry.asset.contentHash}</code></dd>
      <dt>Created</dt><dd>{new Date(entry.asset.createdAt).toLocaleString()}</dd>
      {entry.asset.archivedAt && <><dt>Archived</dt><dd>{new Date(entry.asset.archivedAt).toLocaleString()}</dd></>}
    </dl>
    <Tags values={entry.tags} label={`${kindLabels[entry.kind]} tags`} />
    {entry.kind === "profile" ? <ProfileDetails asset={entry.asset} /> : entry.kind === "instruction" ? <InstructionDetails asset={entry.asset} /> : entry.kind === "technique" ? <TechniqueDetails asset={entry.asset} /> : entry.kind === "recipe" ? <RecipeDetails asset={entry.asset} knownAssetRevisionIds={knownAssetRevisionIds} /> : <PipelineDetails asset={entry.asset} />}
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

export function PayloadArsenal({ profiles, instructions, techniques, pipelines, recipes, sessionId, selectedTransformId, selectedProfileRevisionId, selectedInstructionRevisionId, selectedTechniqueRevisionIds, selectedPipelineRevisionId, loading, error, onSelectTransform, onSelectProfile, onSelectInstruction, onSelectTechnique, onSelectPipeline, onReplayRecipe }: PayloadArsenalProps) {
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
  const [trustedRecipeRevision, setTrustedRecipeRevision] = useState<PayloadAssetRevision | null>(null);
  const [locallyArchivedRecipeIds, setLocallyArchivedRecipeIds] = useState<Set<string>>(() => new Set());
  const [archiveMessage, setArchiveMessage] = useState<string | null>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleRecipes = useMemo(() => trustedRecipeRevision && !recipes.some((asset) => asset.id === trustedRecipeRevision.id) ? [...recipes, trustedRecipeRevision] : recipes, [recipes, trustedRecipeRevision]);
  const displayedRecipes = useMemo(() => visibleRecipes.map((asset) => locallyArchivedRecipeIds.has(asset.id) && !asset.archivedAt ? { ...asset, archivedAt: new Date().toISOString() } : asset), [locallyArchivedRecipeIds, visibleRecipes]);
  const entries = useMemo(() => buildEntries(profiles, instructions, techniques, pipelines, displayedRecipes), [profiles, instructions, techniques, pipelines, displayedRecipes]);
  const knownAssetRevisionIds = useMemo(() => new Set(entries.flatMap((entry) => entry.kind === "transform" || entry.kind === "recipe" ? [] : [entry.asset.id])), [entries]);
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
  const archiveRecipe = useMutation({
    mutationFn: (asset: PayloadAssetRevision) => api(`/api/library/assets/${asset.id}`, { method: "DELETE" }),
    onSuccess: (_response, asset) => {
      setState("all");
      setLocallyArchivedRecipeIds((current) => new Set(current).add(asset.id));
      setArchiveMessage(`Archived exact recipe revision ${asset.id}.`);
      void queryClient.invalidateQueries({ queryKey: ["assets", "payload-recipe"] });
      void queryClient.invalidateQueries({ queryKey: ["assets", "payload-recipe", "include-archived"] });
    },
    onError: () => setArchiveMessage(null)
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
      : inspected && inspected.kind !== "recipe" && !inspected.asset.trusted ? "Untrusted revisions remain inspectable but cannot be selected for execution."
        : inspected?.kind === "pipeline" && pipelineIssues(inspected.asset).length > 0 ? "This pipeline references transforms or versions unavailable in this build."
          : null;
  const selectInspected = () => {
    if (!inspected) return;
    if (inspected.kind === "transform") onSelectTransform(inspected.transform);
    else if (inspected.kind === "profile") onSelectProfile(inspected.asset);
    else if (inspected.kind === "instruction") onSelectInstruction(inspected.asset);
    else if (inspected.kind === "technique") onSelectTechnique(inspected.asset);
    else if (inspected.kind === "pipeline") onSelectPipeline(inspected.asset);
  };
  const cloneInspected = async () => {
    if (!inspected || inspected.kind === "transform" || inspected.kind === "recipe") return;
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
  const archiveInspectedRecipe = async () => {
    if (!inspected || inspected.kind !== "recipe" || inspected.asset.archivedAt || locallyArchivedRecipeIds.has(inspected.asset.id)) return;
    archiveRecipe.reset();
    setArchiveMessage(null);
    const approved = await dialogs.confirm({
      title: `Archive recipe “${inspected.asset.name}”?`,
      description: `This archives exact recipe revision r${inspected.asset.revision}. Lathe will refuse the archive while another saved record references it. Captured payload revisions and conversation history are not removed.`,
      confirmLabel: "Archive recipe",
      danger: true
    });
    if (approved) archiveRecipe.mutate(inspected.asset);
  };
  return <div className="payload-arsenal">
    <header className="payload-arsenal-heading"><div><Library size={17} /><span><strong>Searchable arsenal</strong><small>Inspect exact immutable revisions, then explicitly select one for Transform or Generate.</small></span></div><output aria-live="polite">{results.length} of {entries.length}</output></header>
    <section className="payload-arsenal-filters" aria-label="Arsenal filters">
      <Field label="Search"><div className="payload-arsenal-search"><Search size={13} /><Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, ID, tag, backend…" /></div></Field>
      <Field label="Kind"><Select value={kind} onChange={(event) => selectKind(event.target.value as KindFilter)}><option value="all">All kinds</option><option value="transform">Transforms</option><option value="profile">Generator profiles</option><option value="instruction">Instructions</option><option value="technique">Techniques</option><option value="pipeline">Pipelines</option><option value="recipe">Recipes</option></Select></Field>
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
        {!inspected ? <p className="payload-arsenal-empty">Choose an entry to inspect it.</p> : <>
          <header><div><EntryIcon kind={inspected.kind} /><span><small>{kindLabels[inspected.kind]}</small><h3>{inspected.name}</h3></span></div><Badges entry={inspected} /></header>
          <p>{inspected.description || "No description"}</p>
          {inspected.kind === "transform" ? <TransformDetails transform={inspected.transform} /> : <>
            <AssetDetails entry={inspected} knownAssetRevisionIds={knownAssetRevisionIds} />
            {compareEntry && <section className="payload-arsenal-compare"><h4>Compare same-lineage revision</h4><Field label="Compare with revision"><Select value={compareEntry.asset.id} onChange={(event) => setCompareRevisionId(event.target.value)}>{siblingEntries.map((entry) => <option value={entry.asset.id} key={entry.asset.id}>r{entry.asset.revision} · {entry.asset.id}{entry.asset.archivedAt ? " · archived" : ""}</option>)}</Select></Field><RevisionComparison left={inspected.asset} right={compareEntry.asset} /></section>}
          </>}
          {inspected.kind === "recipe" && <RecipeReplay key={inspected.asset.id} asset={inspected.asset} sessionId={sessionId} archived={Boolean(inspected.asset.archivedAt)} trusted={inspected.asset.trusted} knownAssetRevisionIds={knownAssetRevisionIds} onReplay={onReplayRecipe} onTrusted={(trustedAsset) => { setTrustedRecipeRevision(trustedAsset); setInspectedKey(`recipe:${trustedAsset.id}`); }} />}
          <footer><div className="payload-arsenal-actions">
            {inspected.kind !== "transform" && inspected.kind !== "recipe" && <Button type="button" variant="secondary" disabled={clone.isPending} onClick={() => void cloneInspected()}><CopyPlus size={13} /> {clone.isPending ? "Cloning…" : "Clone as new item"}</Button>}
            {inspected.kind === "recipe" && <Button type="button" variant="danger" disabled={Boolean(inspected.asset.archivedAt) || locallyArchivedRecipeIds.has(inspected.asset.id) || archiveRecipe.isPending} onClick={() => void archiveInspectedRecipe()}><Archive size={13} /> {archiveRecipe.isPending ? "Archiving…" : "Archive recipe"}</Button>}
            {inspected.kind !== "recipe" && <Button type="button" disabled={actionSelected || Boolean(actionDisabledReason)} onClick={selectInspected}>{actionSelected ? <><Check size={13} /> Selected</> : inspected.kind === "profile" ? "Select exact profile" : inspected.kind === "technique" ? "Add exact technique" : inspected.kind === "instruction" ? "Select exact instruction" : inspected.kind === "pipeline" ? "Select exact pipeline" : "Select transform"}</Button>}
          </div>{actionDisabledReason && <small>{actionDisabledReason}</small>}{cloneMessage && <small role="status">{cloneMessage}</small>}{archiveMessage && <small role="status">{archiveMessage}</small>}{archiveRecipe.error && <div className="form-error" role="alert"><p>{archiveRecipe.error.message}</p>{resourceReferences(archiveRecipe.error).length > 0 && <ul>{resourceReferences(archiveRecipe.error).map((reference, index) => <li key={`${reference.kind}:${reference.label}:${index}`}><strong>{reference.kind}</strong> · {reference.label} · {reference.detail}</li>)}</ul>}</div>}</footer>
        </>}
      </aside>
    </div>
  </div>;
}
