import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CopyPlus, GitCompare, ListRestart, Send, WandSparkles, X } from "lucide-react";
import {
  countUnicodeCodePoints,
  normalizePayloadTransformParameters,
  payloadTransforms,
  type PayloadTransformId
} from "@lathe/payloads";
import { api, jsonBody } from "../api.js";
import type { PayloadRevision, PayloadVariantMatrixDraft } from "../payload-workbench-api.js";
import { Button, Field, Select } from "./forms.js";
import { PayloadTextComparison } from "./payload-inspection.js";
import { PayloadTransformParameterFields } from "./payload-transform-parameters.js";

const MAX_MATRIX_ROWS = 32;
const MAX_CONTROL_PREVIEW_CODE_POINTS = 20_000;

export const defaultPayloadVariantMatrixDraft: PayloadVariantMatrixDraft = {
  transformId: "caesar-rotate",
  version: 1,
  parameterSets: [{ shift: "1" }, { shift: "13" }]
};

interface PayloadVariantPreflight {
  preflightHash: string | null;
  source: {
    revisionId: string | null;
    contentHash: string;
    codePoints: number;
    utf8Bytes: number | null;
  };
  transform: { id: PayloadTransformId; version: 1 };
  rows: Array<{
    ordinal: number;
    parameters: Record<string, string> | null;
    contentHash: string | null;
    codePoints: number | null;
    utf8Bytes: number | null;
    codePointDelta: number | null;
    utf8ByteDelta: number | null;
    duplicateOutputOrdinals: number[];
    matchesControl: boolean | null;
  }>;
  totals: { rowCount: number; codePoints: number; utf8Bytes: number };
  limits: { maxRows: number; maxTotalCodePoints: number; maxTotalUtf8Bytes: number };
  violations: Array<{ code: string; message: string; ordinal: number | null }>;
  creatable: boolean;
}

interface PayloadVariantMatrixResponse {
  matrix: {
    id: string;
    sourceRevisionId: string;
    sourceContentHash: string;
    transformId: PayloadTransformId;
    version: 1;
    count: number;
    preflightHash: string;
    createdAt: string;
  };
  variants: PayloadRevision[];
}

export interface PayloadVariantMatrixProps {
  sessionId: string | null;
  sourceText: string;
  sourceRevision: { id: string; text: string | null } | null;
  draft: PayloadVariantMatrixDraft;
  historyRevisions: PayloadRevision[];
  disabled?: boolean;
  configIssue?: string | null;
  onDraftChange(draft: PayloadVariantMatrixDraft): void;
  onSourceRecorded(revisionId: string, text: string): void;
  onRestore(revision: PayloadRevision): void;
  onSendToTransform(revision: PayloadRevision): void;
  onUse(revision: PayloadRevision): void;
}

interface MatrixGroup {
  id: string;
  preflightHash: string;
  sourceRevisionId: string;
  sourceHash: string;
  sourceText: string | null;
  transformId: string;
  version: number;
  count: number;
  createdAt: string;
  variants: PayloadRevision[];
}

interface LocalMatrix {
  response: PayloadVariantMatrixResponse;
  preflightHash: string;
  controlText: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cloneDraft(draft: PayloadVariantMatrixDraft): PayloadVariantMatrixDraft {
  return { transformId: draft.transformId, version: draft.version, parameterSets: draft.parameterSets.map((parameters) => ({ ...parameters })) };
}

export function normalizePayloadVariantMatrixDraft(value: PayloadVariantMatrixDraft | null | undefined): PayloadVariantMatrixDraft {
  const fallback = cloneDraft(defaultPayloadVariantMatrixDraft);
  if (!value) return fallback;
  const parameterSets = value.parameterSets.slice(0, MAX_MATRIX_ROWS).map((parameters) => ({ ...parameters }));
  return { transformId: value.transformId, version: value.version, parameterSets };
}

function codePointPreview(value: string): { text: string; total: number; truncated: boolean } {
  const characters: string[] = [];
  let total = 0;
  for (const character of value) {
    if (total < MAX_CONTROL_PREVIEW_CODE_POINTS) characters.push(character);
    total += 1;
  }
  return { text: characters.join(""), total, truncated: total > MAX_CONTROL_PREVIEW_CODE_POINTS };
}

function historyMatrixGroups(revisions: PayloadRevision[]): MatrixGroup[] {
  const active = revisions.filter((revision) => !revision.deletedAt);
  const byId = new Map(active.map((revision) => [revision.id, revision]));
  const groups = new Map<string, PayloadRevision[]>();
  for (const revision of active) {
    const provenance = record(revision.provenance);
    const matrixId = provenance.kind === "variant-matrix" ? stringValue(provenance.matrixId) : null;
    if (!matrixId) continue;
    groups.set(matrixId, [...(groups.get(matrixId) ?? []), revision]);
  }
  return [...groups.entries()].flatMap(([id, variants]) => {
    const ordered = variants.toSorted((left, right) => {
      const leftOrdinal = numberValue(record(left.provenance).ordinal) ?? left.ordinal;
      const rightOrdinal = numberValue(record(right.provenance).ordinal) ?? right.ordinal;
      return leftOrdinal - rightOrdinal;
    });
    const first = ordered[0];
    if (!first) return [];
    const provenance = record(first.provenance);
    const sourceRevisionId = first.parentRevisionId ?? "";
    const source = byId.get(sourceRevisionId);
    return [{
      id,
      preflightHash: stringValue(provenance.preflightHash) ?? "",
      sourceRevisionId,
      sourceHash: stringValue(provenance.sourceHash) ?? source?.contentHash ?? "",
      sourceText: source?.text ?? null,
      transformId: stringValue(provenance.transformId) ?? "unknown",
      version: numberValue(provenance.version) ?? 1,
      count: numberValue(provenance.variantCount) ?? ordered.length,
      createdAt: ordered.map((revision) => revision.createdAt ?? "").toSorted().at(-1) ?? "",
      variants: ordered
    } satisfies MatrixGroup];
  }).toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function localMatrixGroup(item: LocalMatrix): MatrixGroup {
  return {
    id: item.response.matrix.id,
    preflightHash: item.response.matrix.preflightHash || item.preflightHash,
    sourceRevisionId: item.response.matrix.sourceRevisionId,
    sourceHash: item.response.matrix.sourceContentHash,
    sourceText: item.controlText,
    transformId: item.response.matrix.transformId,
    version: item.response.matrix.version,
    count: item.response.matrix.count,
    createdAt: item.response.matrix.createdAt,
    variants: item.response.variants
  };
}

function signed(value: number): string {
  return value > 0 ? `+${value.toLocaleString()}` : value.toLocaleString();
}

function formatBytes(value: number): string {
  return `${value.toLocaleString()} B`;
}

function formatMetric(value: number | null, suffix: string): string {
  return value === null ? "Unavailable" : `${value.toLocaleString()} ${suffix}`;
}

function formatSigned(value: number | null, suffix = ""): string {
  return value === null ? "unavailable" : `${signed(value)}${suffix}`;
}

export function PayloadVariantMatrix({
  sessionId,
  sourceText,
  sourceRevision,
  draft,
  historyRevisions,
  disabled = false,
  configIssue = null,
  onDraftChange,
  onSourceRecorded,
  onRestore,
  onSendToTransform,
  onUse
}: PayloadVariantMatrixProps) {
  const queryClient = useQueryClient();
  const [localMatrices, setLocalMatrices] = useState<LocalMatrix[]>([]);
  const selectedTransform = draft.version === 1
    ? payloadTransforms.find((transform) => transform.id === draft.transformId && transform.version === draft.version)
    : undefined;
  const incompatibility = configIssue ?? (!selectedTransform
    ? `The saved transform ${draft.transformId}@${draft.version} is unavailable. Select a supported transform to replace it.`
    : null);
  const source = { text: sourceText, revisionId: sourceRevision?.id ?? null };
  const requestKey = JSON.stringify({ sessionId, source, transformId: selectedTransform?.id ?? draft.transformId, version: draft.version, parameterSets: draft.parameterSets });
  const preflight = useMutation({
    mutationFn: async (input: { key: string; body: { source: typeof source; transformId: string; version: 1; parameterSets: Array<Record<string, string>> } }) => ({
      key: input.key,
      response: await api<{ preflight: PayloadVariantPreflight }>(`/api/sessions/${sessionId}/payload-variant-matrices/preflight`, {
        method: "POST",
        ...jsonBody(input.body)
      })
    })
  });
  const currentPreflight = preflight.isSuccess && preflight.data.key === requestKey ? preflight.data.response.preflight : null;
  const preflightStale = Boolean(preflight.data && preflight.data.key !== requestKey);
  const create = useMutation({
    mutationFn: async (input: { controlText: string; preflightHash: string; source: typeof source; transformId: PayloadTransformId; version: 1; parameterSets: Array<Record<string, string>> }) => {
      if (!sessionId) throw new Error("Open the Payload Workbench from a session to create variants.");
      const response = await api<PayloadVariantMatrixResponse>(`/api/sessions/${sessionId}/payload-variant-matrices`, {
        method: "POST",
        ...jsonBody({
          source: input.source,
          transformId: input.transformId,
          version: input.version,
          parameterSets: input.parameterSets,
          preflightHash: input.preflightHash
        })
      });
      return { response, preflightHash: input.preflightHash, controlText: input.controlText };
    },
    onSuccess: (result) => {
      setLocalMatrices((current) => [{ response: result.response, preflightHash: result.preflightHash, controlText: result.controlText }, ...current.filter((item) => item.response.matrix.id !== result.response.matrix.id)]);
      onSourceRecorded(result.response.matrix.sourceRevisionId, result.controlText);
      preflight.reset();
      void queryClient.invalidateQueries({ queryKey: ["payload-generations", sessionId] });
    },
    onError: () => preflight.reset()
  });
  const groups = useMemo(() => {
    const persisted = historyMatrixGroups(historyRevisions);
    const byId = new Map(persisted.map((group) => [group.id, group]));
    for (const item of localMatrices) {
      const group = localMatrixGroup(item);
      if (!byId.has(group.id)) byId.set(group.id, group);
    }
    return [...byId.values()].toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [historyRevisions, localMatrices]);
  const sourcePreview = useMemo(() => codePointPreview(sourceText), [sourceText]);
  const controlsDisabled = disabled || !sessionId || preflight.isPending || create.isPending;
  const updateParameters = (index: number, parameters: Record<string, string>) => onDraftChange({
    ...draft,
    parameterSets: draft.parameterSets.map((item, itemIndex) => itemIndex === index ? parameters : item)
  });
  const selectTransform = (transformId: PayloadTransformId) => onDraftChange({
    transformId,
    version: 1,
    parameterSets: [{ ...normalizePayloadTransformParameters(transformId) }]
  });
  const addFactor = () => {
    if (!selectedTransform || draft.parameterSets.length >= MAX_MATRIX_ROWS) return;
    const prior = draft.parameterSets.at(-1) ?? normalizePayloadTransformParameters(selectedTransform.id);
    onDraftChange({ ...draft, parameterSets: [...draft.parameterSets, { ...prior }] });
  };
  const removeFactor = (index: number) => {
    if (draft.parameterSets.length <= 1) return;
    onDraftChange({ ...draft, parameterSets: draft.parameterSets.filter((_, itemIndex) => itemIndex !== index) });
  };
  const runPreflight = () => {
    if (!sessionId || !selectedTransform || incompatibility) return;
    preflight.mutate({
      key: requestKey,
      body: {
        source: { ...source },
        transformId: selectedTransform.id,
        version: selectedTransform.version,
        parameterSets: draft.parameterSets.map((parameters) => ({ ...parameters }))
      }
    });
  };
  const createVariants = () => {
    if (!selectedTransform || !currentPreflight?.creatable || !currentPreflight.preflightHash) return;
    create.mutate({
      controlText: sourceText,
      preflightHash: currentPreflight.preflightHash,
      source: { ...source },
      transformId: selectedTransform.id,
      version: selectedTransform.version,
      parameterSets: draft.parameterSets.map((parameters) => ({ ...parameters }))
    });
  };

  return <section className="payload-variant-matrix" aria-label="Payload variant matrix">
    <header className="payload-variant-heading">
      <div><GitCompare size={17} /><span><strong>Deterministic variant matrix</strong><small>One registry transform, explicit factor rows, and no model calls.</small></span></div>
      <output aria-live="polite">{draft.parameterSets.length} factor{draft.parameterSets.length === 1 ? "" : "s"}</output>
    </header>
    <div className="payload-variant-messages">
      {!sessionId && <div className="form-error" role="alert">Open this workbench from a session to preflight and create immutable variants.</div>}
      {incompatibility && <div className="form-error" role="alert">{incompatibility}</div>}
    </div>
    <div className="payload-variant-layout">
      <aside className="payload-variant-controls">
        <section className="payload-variant-source" aria-label="Variant matrix control source">
          <header><strong>Control / source text</strong><span>{sourcePreview.total.toLocaleString()} code points · authoritative UTF-8 size after preflight</span></header>
          <pre>{sourcePreview.text}</pre>
          {sourcePreview.truncated && <p>Showing the first {MAX_CONTROL_PREVIEW_CODE_POINTS.toLocaleString()} code points. The authoritative draft is unchanged.</p>}
          {sourceRevision?.text === sourceText && <small>Exact revision · <code>{sourceRevision.id}</code></small>}
        </section>
        <Field label="Registry transform" hint="Every factor uses this exact built-in transform version.">
          <Select disabled={disabled || preflight.isPending || create.isPending} value={incompatibility ? "" : selectedTransform?.id ?? ""} onChange={(event) => selectTransform(event.target.value as PayloadTransformId)}>
            {incompatibility && <option value="">Select a supported transform…</option>}
            {payloadTransforms.filter((transform) => transform.parameterSchema.mode !== "variables").map((transform) => <option value={transform.id} key={transform.id}>{transform.label} · v{transform.version}</option>)}
          </Select>
        </Field>
        {selectedTransform && !incompatibility && <div className="payload-variant-transform-summary"><strong>{selectedTransform.label}</strong><code>{selectedTransform.id}@{selectedTransform.version}</code><p>{selectedTransform.description}</p></div>}
        {selectedTransform && !incompatibility && <section className="payload-variant-factors" aria-label="Variant factor rows">
          <header><div><strong>Parameter rows</strong><small>Each row produces one immutable child revision.</small></div><Button type="button" variant="secondary" onClick={addFactor} disabled={controlsDisabled || draft.parameterSets.length >= MAX_MATRIX_ROWS}><CopyPlus size={12} /> Add factor</Button></header>
          {draft.parameterSets.map((parameters, index) => <fieldset aria-label={`Factor ${index + 1} parameters`} key={index}>
            <legend>Factor {index + 1}</legend>
            <Button type="button" variant="ghost" aria-label={`Remove factor ${index + 1}`} title="Remove factor" onClick={() => removeFactor(index)} disabled={controlsDisabled || draft.parameterSets.length <= 1}><X size={12} /></Button>
            <PayloadTransformParameterFields compact definition={selectedTransform} value={parameters} onChange={(value) => updateParameters(index, value)} disabled={controlsDisabled} />
            {selectedTransform.parameterSchema.mode === "none" && <p>This transform has no parameters. Additional rows would be exact duplicate factors.</p>}
          </fieldset>)}
        </section>}
        <div className="payload-variant-preflight-actions">
          <Button type="button" variant="secondary" onClick={runPreflight} disabled={controlsDisabled || Boolean(incompatibility) || !selectedTransform}>{preflight.isPending ? "Checking…" : "Run authoritative preflight"}</Button>
          <Button type="button" onClick={createVariants} disabled={controlsDisabled || !currentPreflight?.creatable || !currentPreflight.preflightHash}>{create.isPending ? "Creating…" : "Create variants"}</Button>
        </div>
        {preflightStale && <p className="payload-variant-stale" role="status">Source, transform, or factors changed. Run preflight again before creating.</p>}
        {(preflight.error || create.error) && <div className="form-error" role="alert">{preflight.error?.message ?? create.error?.message}</div>}
        {currentPreflight && <section className={`payload-variant-preflight${currentPreflight.creatable ? " ready" : " blocked"}`} aria-label="Authoritative variant preflight">
          <header><div><strong>{currentPreflight.creatable ? "Ready to create" : "Creation blocked"}</strong><code>{currentPreflight.preflightHash ?? "Unavailable"}</code></div><span>{currentPreflight.totals.rowCount} rows</span></header>
          <dl>
            <dt>Control</dt><dd>{formatMetric(currentPreflight.source.codePoints, "code points")} · {currentPreflight.source.utf8Bytes === null ? "Unavailable" : formatBytes(currentPreflight.source.utf8Bytes)}</dd>
            <dt>Aggregate</dt><dd>{currentPreflight.totals.codePoints.toLocaleString()} code points · {formatBytes(currentPreflight.totals.utf8Bytes)}</dd>
            <dt>Hard limits</dt><dd>{currentPreflight.limits.maxRows} rows · {currentPreflight.limits.maxTotalCodePoints.toLocaleString()} code points · {formatBytes(currentPreflight.limits.maxTotalUtf8Bytes)}</dd>
          </dl>
          {currentPreflight.violations.length > 0 && <div className="payload-variant-violations" role="alert">{currentPreflight.violations.map((violation, index) => <p key={`${violation.code}:${violation.ordinal ?? "all"}:${index}`}><strong>{violation.ordinal === null ? "Matrix" : `Factor ${violation.ordinal}`}</strong>{violation.message}</p>)}</div>}
          <ol>{currentPreflight.rows.map((row) => <li key={row.ordinal}><header><strong>Factor {row.ordinal}</strong><code>{row.contentHash ?? "Unavailable"}</code></header><span>{formatMetric(row.codePoints, "code points")} ({formatSigned(row.codePointDelta)}) · {row.utf8Bytes === null ? "Unavailable" : formatBytes(row.utf8Bytes)} ({formatSigned(row.utf8ByteDelta, " B")})</span><pre>{row.parameters === null ? "Parameters unavailable" : JSON.stringify(row.parameters, null, 2)}</pre>{row.matchesControl && <small>Output exactly matches the control.</small>}{row.duplicateOutputOrdinals.length > 0 && <small>Same output as factor {row.duplicateOutputOrdinals.join(", ")}.</small>}</li>)}</ol>
        </section>}
      </aside>
      <main className="payload-variant-results" aria-label="Variant matrix results">
        {groups.length === 0 && <div className="payload-variant-empty"><GitCompare size={22} /><strong>No variant matrices yet</strong><p>Preflight the current control, then explicitly create immutable variants.</p></div>}
        {groups.map((group) => <section className="payload-variant-group" aria-label={`Variant matrix ${group.id}`} key={group.id}>
          <header><div><strong>{group.transformId}@{group.version}</strong><code>{group.id}</code></div><span>{group.variants.length}/{group.count} variants</span></header>
          <dl><dt>Source revision</dt><dd><code>{group.sourceRevisionId || "Unavailable"}</code></dd><dt>Source hash</dt><dd><code>{group.sourceHash}</code></dd><dt>Preflight</dt><dd><code>{group.preflightHash}</code></dd></dl>
          <div className="payload-variant-card-grid">{group.variants.map((variant) => {
            const provenance = record(variant.provenance);
            const ordinal = numberValue(provenance.ordinal) ?? variant.ordinal;
            const parameters = record(provenance.parameters);
            const duplicateOutputOf = numberValue(provenance.duplicateOutputOf);
            const outputCodePoints = numberValue(provenance.outputCodePoints) ?? countUnicodeCodePoints(variant.text);
            const outputUtf8Bytes = numberValue(provenance.outputUtf8Bytes);
            const matchesControl = provenance.matchesControl === true || Boolean(group.sourceHash && variant.contentHash === group.sourceHash);
            return <article className="payload-variant-card" aria-label={`Variant factor ${ordinal}`} key={variant.id}>
              <header><div><strong>Factor {ordinal}</strong><span>{outputCodePoints.toLocaleString()} code points · {outputUtf8Bytes === null ? "UTF-8 size unavailable" : formatBytes(outputUtf8Bytes)}</span></div><code>{variant.id}</code></header>
              <pre className="payload-variant-text">{variant.text}</pre>
              <details><summary>Exact factor provenance</summary><dl><dt>Parameters</dt><dd><pre>{JSON.stringify(parameters, null, 2)}</pre></dd><dt>Content hash</dt><dd><code>{variant.contentHash ?? "Unavailable"}</code></dd>{matchesControl && <><dt>Control match</dt><dd>Exact output match</dd></>}{duplicateOutputOf !== null && <><dt>Duplicate output of</dt><dd>Factor {duplicateOutputOf}</dd></>}</dl></details>
              <details><summary>Compare raw control and variant</summary>{group.sourceText === null ? <p>The exact source revision is unavailable in current history.</p> : <PayloadTextComparison left={group.sourceText} right={variant.text} leftLabel="Exact control" rightLabel={`Factor ${ordinal}`} />}</details>
              <footer><Button type="button" variant="secondary" onClick={() => onRestore(variant)}><ListRestart size={12} /> Restore</Button><Button type="button" variant="secondary" onClick={() => onSendToTransform(variant)}><Send size={12} /> Send to Transform</Button><Button type="button" onClick={() => onUse(variant)}><WandSparkles size={12} /> Use as next prompt</Button></footer>
            </article>;
          })}</div>
        </section>)}
      </main>
    </div>
  </section>;
}
