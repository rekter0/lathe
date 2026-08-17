import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  applyPayloadTransform,
  countUnicodeCodePoints,
  inversePayloadTransformParameters,
  type PayloadTransformDefinition
} from "@lathe/payloads";
import { RenderedMarkdown } from "./rendered-markdown.js";

const MAX_TEXT_PREVIEW_CODE_POINTS = 20_000;
const MAX_BYTE_PREVIEW_BYTES = 16_384;

type InspectionMode = "raw" | "rendered" | "parent" | "escaped" | "code-points" | "bytes" | "round-trip";

export interface PayloadTransformApplicationInspection {
  definition: PayloadTransformDefinition;
  parameters: Readonly<Record<string, string>>;
  parentText: string;
  outputText: string;
}

interface TextPreview {
  text: string;
  shown: number;
  total: number;
  truncated: boolean;
}

function takeCodePoints(value: string, maximum: number): TextPreview {
  const output: string[] = [];
  let total = 0;
  for (const character of value) {
    if (total < maximum) output.push(character);
    total += 1;
  }
  return { text: output.join(""), shown: Math.min(total, maximum), total, truncated: total > maximum };
}

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0)!;
  if (character === "\\") return "\\\\";
  if (character === "\n") return "\\n";
  if (character === "\r") return "\\r";
  if (character === "\t") return "\\t";
  if (character === "\b") return "\\b";
  if (character === "\f") return "\\f";
  if (codePoint >= 0x20 && codePoint <= 0x7e) return character;
  return codePoint <= 0xffff
    ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
    : `\\u{${codePoint.toString(16).toUpperCase()}}`;
}

function escapedPreview(value: string): TextPreview {
  const preview = takeCodePoints(value, MAX_TEXT_PREVIEW_CODE_POINTS);
  return { ...preview, text: [...preview.text].map(unicodeEscape).join("") };
}

const namedCharacters = new Map<number, string>([
  [0x00, "NUL"], [0x09, "TAB"], [0x0a, "LF"], [0x0d, "CR"], [0x20, "SPACE"],
  [0x200b, "ZERO WIDTH SPACE"], [0x200c, "ZERO WIDTH NON-JOINER"], [0x200d, "ZERO WIDTH JOINER"],
  [0x202a, "LEFT-TO-RIGHT EMBEDDING"], [0x202b, "RIGHT-TO-LEFT EMBEDDING"], [0x202d, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202e, "RIGHT-TO-LEFT OVERRIDE"], [0x2060, "WORD JOINER"], [0xfeff, "ZERO WIDTH NO-BREAK SPACE"]
]);

function visibleCodePoint(character: string, codePoint: number): string {
  const named = namedCharacters.get(codePoint);
  if (named) return `<${named}>`;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return `<CONTROL>`;
  return character;
}

function codePointPreview(value: string): TextPreview {
  const lines: string[] = [];
  let total = 0;
  for (const character of value) {
    if (total < MAX_TEXT_PREVIEW_CODE_POINTS) {
      const codePoint = character.codePointAt(0)!;
      const label = `U+${codePoint.toString(16).toUpperCase().padStart(codePoint <= 0xffff ? 4 : 6, "0")}`;
      lines.push(`${String(total).padStart(7, "0")}  ${label}  ${visibleCodePoint(character, codePoint)}`);
    }
    total += 1;
  }
  return { text: lines.join("\n"), shown: Math.min(total, MAX_TEXT_PREVIEW_CODE_POINTS), total, truncated: total > MAX_TEXT_PREVIEW_CODE_POINTS };
}

function bytePreview(value: string): TextPreview {
  const bytes = new TextEncoder().encode(value);
  const shown = Math.min(bytes.length, MAX_BYTE_PREVIEW_BYTES);
  const lines: string[] = [];
  for (let offset = 0; offset < shown; offset += 16) {
    const row = bytes.subarray(offset, Math.min(shown, offset + 16));
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}`);
  }
  return { text: lines.join("\n"), shown, total: bytes.length, truncated: bytes.length > shown };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) return true;
  }
  return false;
}

function PreviewNotice({ preview, unit }: { preview: TextPreview; unit: string }) {
  if (!preview.truncated) return null;
  return <p className="payload-inspection-truncated">Showing the first {preview.shown.toLocaleString()} of {preview.total.toLocaleString()} {unit}. The authoritative draft is not truncated.</p>;
}

export function PayloadTextComparison({ left, right, leftLabel, rightLabel }: { left: string; right: string; leftLabel: string; rightLabel: string }) {
  const leftPreview = useMemo(() => takeCodePoints(left, MAX_TEXT_PREVIEW_CODE_POINTS), [left]);
  const rightPreview = useMemo(() => takeCodePoints(right, MAX_TEXT_PREVIEW_CODE_POINTS), [right]);
  return <div className="payload-text-comparison">
    <article><h4>{leftLabel}</h4><pre>{leftPreview.text}</pre><PreviewNotice preview={leftPreview} unit="code points" /></article>
    <article><h4>{rightLabel}</h4><pre>{rightPreview.text}</pre><PreviewNotice preview={rightPreview} unit="code points" /></article>
  </div>;
}

export function PayloadInspectionPanel({ value, selectedTransform, application }: {
  value: string;
  selectedTransform: PayloadTransformDefinition;
  application: PayloadTransformApplicationInspection | null;
}) {
  const [mode, setMode] = useState<InspectionMode>("raw");
  const tabsId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const raw = useMemo(() => takeCodePoints(value, MAX_TEXT_PREVIEW_CODE_POINTS), [value]);
  const escaped = useMemo(() => mode === "escaped" ? escapedPreview(value) : null, [mode, value]);
  const codePoints = useMemo(() => mode === "code-points" ? codePointPreview(value) : null, [mode, value]);
  const bytes = useMemo(() => mode === "bytes" ? bytePreview(value) : null, [mode, value]);
  const staleApplication = Boolean(application && application.outputText !== value);
  const roundTrip = useMemo(() => {
    if (!application || staleApplication || !application.definition.inverseTransformId) {
      return { status: "unavailable" as const, text: "No exact directional inverse is available for the current draft." };
    }
    try {
      const inverseParameters = inversePayloadTransformParameters(application.definition.id, application.parameters);
      if (inverseParameters === null) return { status: "unavailable" as const, text: "No exact directional inverse is available for the current draft." };
      const restored = applyPayloadTransform(application.definition.inverseTransformId, value, inverseParameters);
      return restored === application.parentText
        ? { status: "verified" as const, text: "The declared inverse reproduced the parent text exactly." }
        : { status: "mismatch" as const, text: "The declared inverse completed, but did not reproduce the parent text exactly.", restored };
    } catch (error) {
      return { status: "error" as const, text: error instanceof Error ? error.message : "The declared inverse failed." };
    }
  }, [application, staleApplication, value]);
  const modes: Array<{ id: InspectionMode; label: string }> = [
    { id: "raw", label: "Raw" }, { id: "rendered", label: "Rendered Markdown" }, { id: "parent", label: "Parent" }, { id: "escaped", label: "Escaped" },
    { id: "code-points", label: "Code points" }, { id: "bytes", label: "UTF-8 bytes" }, { id: "round-trip", label: "Round-trip" }
  ];
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % modes.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + modes.length) % modes.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = modes.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextMode = modes[nextIndex];
    if (!nextMode) return;
    setMode(nextMode.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return <section className="payload-inspection" aria-label="Payload inspection">
    <header><div><strong>Inspect payload</strong><span>{countUnicodeCodePoints(value).toLocaleString()} code points · {new TextEncoder().encode(value).byteLength.toLocaleString()} bytes</span></div><div className="payload-inspection-badges"><span>{selectedTransform.inputKind} → {selectedTransform.outputKind}</span><span>{selectedTransform.lossiness}</span><span>≤ {selectedTransform.limits.maxOutputCodePoints.toLocaleString()} code points</span></div></header>
    <div className="payload-inspection-transform"><strong>{selectedTransform.label}</strong><p>{selectedTransform.description}</p><div>{selectedTransform.riskFlags.map((flag) => <span key={flag}>{flag.replaceAll("-", " ")}</span>)}</div><small>{selectedTransform.expansion.summary}</small>{selectedTransform.warnings.map((warning) => <p className={`payload-transform-warning ${warning.severity}`} key={warning.code}>{warning.message}</p>)}</div>
    <div className="payload-inspection-tabs" role="tablist" aria-label="Payload representation">
      {modes.map((item, index) => <button
        type="button"
        role="tab"
        id={`${tabsId}-${item.id}-tab`}
        aria-controls={`${tabsId}-panel`}
        aria-selected={mode === item.id}
        tabIndex={mode === item.id ? 0 : -1}
        ref={(element) => { tabRefs.current[index] = element; }}
        key={item.id}
        onClick={() => setMode(item.id)}
        onKeyDown={(event) => onTabKeyDown(event, index)}
      >{item.label}</button>)}
    </div>
    <div className="payload-inspection-view" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${mode}-tab`}>
      {mode === "raw" && <><pre>{raw.text}</pre><PreviewNotice preview={raw} unit="code points" /></>}
      {mode === "rendered" && <div className="payload-inspection-rendered"><RenderedMarkdown text={raw.text} /><PreviewNotice preview={raw} unit="code points" /></div>}
      {mode === "parent" && (application && !staleApplication
        ? <PayloadTextComparison left={application.parentText} right={value} leftLabel="Exact parent" rightLabel="Current draft" />
        : <p className="payload-inspection-empty">Apply a transform to compare its exact input and output.</p>)}
      {mode === "escaped" && escaped && <><pre>{escaped.text}</pre><PreviewNotice preview={escaped} unit="code points" /></>}
      {mode === "code-points" && codePoints && <><pre dir="ltr">{codePoints.text}</pre><PreviewNotice preview={codePoints} unit="code points" /></>}
      {mode === "bytes" && bytes && <><pre dir="ltr">{bytes.text}</pre><PreviewNotice preview={bytes} unit="bytes" />{hasUnpairedSurrogate(value) && <p className="payload-transform-warning warning">The draft contains an unpaired UTF-16 surrogate. UTF-8 serialization replaces it with U+FFFD.</p>}</>}
      {mode === "round-trip" && <div className={`payload-round-trip status-${roundTrip.status}`}><strong>{roundTrip.status}</strong><p>{roundTrip.text}</p>{"restored" in roundTrip && <PayloadTextComparison left={application?.parentText ?? ""} right={roundTrip.restored} leftLabel="Exact parent" rightLabel="Inverse result" />}</div>}
    </div>
  </section>;
}
