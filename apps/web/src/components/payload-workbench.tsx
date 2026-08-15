import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Braces, CaseSensitive, Code2, RotateCcw, Sparkles, Undo2, WandSparkles, X } from "lucide-react";
import { Button, Field, Textarea } from "./forms.js";

export type PayloadTransformId =
  | "base64-encode"
  | "base64-decode"
  | "url-encode"
  | "url-decode"
  | "hex-encode"
  | "hex-decode"
  | "uppercase"
  | "lowercase"
  | "reverse"
  | "rot13"
  | "json-escape"
  | "json-unescape"
  | "markdown-frame"
  | "xml-frame"
  | "json-frame"
  | "repeat-twice";

interface PayloadTransform {
  id: PayloadTransformId;
  label: string;
  apply(value: string): string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeHex(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string): string {
  const normalized = value.replace(/\s+/g, "").replace(/^0x/i, "");
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error("Hex input must contain an even number of hexadecimal digits.");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function rot13(value: string): string {
  return value.replace(/[A-Za-z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
  });
}

export const payloadTransformGroups: Array<{ label: string; icon: "code" | "case" | "frame"; transforms: PayloadTransform[] }> = [
  {
    label: "Encoding",
    icon: "code",
    transforms: [
      { id: "base64-encode", label: "Base64 encode", apply: (value) => bytesToBase64(new TextEncoder().encode(value)) },
      { id: "base64-decode", label: "Base64 decode", apply: (value) => new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(value)) },
      { id: "url-encode", label: "URL encode", apply: encodeURIComponent },
      { id: "url-decode", label: "URL decode", apply: decodeURIComponent },
      { id: "hex-encode", label: "UTF-8 hex encode", apply: encodeHex },
      { id: "hex-decode", label: "UTF-8 hex decode", apply: decodeHex }
    ]
  },
  {
    label: "Transform",
    icon: "case",
    transforms: [
      { id: "uppercase", label: "Uppercase", apply: (value) => value.toUpperCase() },
      { id: "lowercase", label: "Lowercase", apply: (value) => value.toLowerCase() },
      { id: "reverse", label: "Reverse", apply: (value) => [...value].reverse().join("") },
      { id: "rot13", label: "ROT13", apply: rot13 },
      { id: "json-escape", label: "JSON escape", apply: (value) => JSON.stringify(value).slice(1, -1) },
      { id: "json-unescape", label: "JSON unescape", apply: (value) => JSON.parse(`"${value}"`) as string }
    ]
  },
  {
    label: "Red-team framing",
    icon: "frame",
    transforms: [
      { id: "markdown-frame", label: "Markdown fence", apply: (value) => `\`\`\`text\n${value}\n\`\`\`` },
      { id: "xml-frame", label: "XML payload", apply: (value) => `<payload>\n${value}\n</payload>` },
      { id: "json-frame", label: "JSON payload", apply: (value) => JSON.stringify({ payload: value }, null, 2) },
      { id: "repeat-twice", label: "Repeat twice", apply: (value) => `${value}\n\n${value}` }
    ]
  }
];

export function applyPayloadTransform(id: PayloadTransformId, value: string): string {
  const transform = payloadTransformGroups.flatMap((group) => group.transforms).find((item) => item.id === id);
  if (!transform) throw new Error(`Unknown payload transform: ${id}`);
  return transform.apply(value);
}

function TransformGroupIcon({ icon }: { icon: "code" | "case" | "frame" }) {
  if (icon === "code") return <Code2 size={14} />;
  if (icon === "case") return <CaseSensitive size={15} />;
  return <Braces size={14} />;
}

export function PayloadWorkbench({ value, onUse }: { value: string; onUse(value: string): void }) {
  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState("");
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      setOriginal(value);
      setDraft(value);
      setHistory([]);
      setError(null);
    }
    setOpen(nextOpen);
  };
  const apply = (transform: PayloadTransform) => {
    try {
      const transformed = transform.apply(draft);
      if (transformed !== draft) setHistory((items) => [...items.slice(-49), draft]);
      setDraft(transformed);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${transform.label} could not be applied.`);
    }
  };
  const undo = () => {
    const prior = history.at(-1);
    if (prior === undefined) return;
    setDraft(prior);
    setHistory((items) => items.slice(0, -1));
    setError(null);
  };
  const reset = () => {
    if (draft !== original) setHistory((items) => [...items.slice(-49), draft]);
    setDraft(original);
    setError(null);
  };
  const byteCount = new TextEncoder().encode(draft).byteLength;

  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild>
      <Button type="button" variant="secondary" className="payload-workbench-trigger" title="Open payload workbench" aria-label="Open payload workbench"><WandSparkles size={16} /></Button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content payload-workbench-dialog">
        <div className="payload-workbench-heading">
          <span className="payload-workbench-mark"><Sparkles size={17} /></span>
          <div><Dialog.Title>Payload workbench</Dialog.Title><Dialog.Description>Encode, transform, and frame the next operator prompt. Changes stay local until you use the result in chat.</Dialog.Description></div>
        </div>
        <div className="payload-workbench-layout">
          <section className="payload-workbench-editor">
            <Field label="Next prompt">
              <Textarea autoFocus value={draft} onChange={(event) => { setDraft(event.target.value); setError(null); }} rows={18} maxLength={1_000_000} placeholder="Draft the next payload…" />
            </Field>
            <div className="payload-workbench-stats"><span>{draft.length.toLocaleString()} characters</span><span>{byteCount.toLocaleString()} UTF-8 bytes</span><span>{history.length} undo step{history.length === 1 ? "" : "s"}</span></div>
            {error && <div className="form-error" role="alert">{error}</div>}
          </section>
          <aside className="payload-toolbox" aria-label="Payload transformations">
            {payloadTransformGroups.map((group) => <section className="payload-tool-group" key={group.label}>
              <h3><TransformGroupIcon icon={group.icon} />{group.label}</h3>
              <div>{group.transforms.map((transform) => <button type="button" onClick={() => apply(transform)} key={transform.id}>{transform.label}</button>)}</div>
            </section>)}
          </aside>
        </div>
        <div className="payload-workbench-footer">
          <div><Button type="button" variant="ghost" onClick={undo} disabled={history.length === 0}><Undo2 size={14} /> Undo</Button><Button type="button" variant="ghost" onClick={reset} disabled={draft === original}><RotateCcw size={14} /> Reset</Button></div>
          <div><Dialog.Close asChild><Button type="button" variant="ghost">Cancel</Button></Dialog.Close><Button type="button" onClick={() => { onUse(draft); setOpen(false); }} disabled={draft.trim().length === 0}><WandSparkles size={14} /> Use as next prompt</Button></div>
        </div>
        <Dialog.Close className="dialog-close" aria-label="Close payload workbench"><X size={17} /></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
