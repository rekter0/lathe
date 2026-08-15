import * as Dialog from "@radix-ui/react-dialog";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { X } from "lucide-react";
import { Button, Field, Input, Textarea } from "./forms.js";

export interface PromptDialogOptions {
  title: string;
  description: string;
  label: string;
  defaultValue?: string;
  confirmLabel?: string;
  multiline?: boolean;
}

export interface ConfirmDialogOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface OperatorDialogApi {
  prompt(options: PromptDialogOptions): Promise<string | null>;
  confirm(options: ConfirmDialogOptions): Promise<boolean>;
}

type PendingDialog =
  | { id: number; kind: "prompt"; options: PromptDialogOptions; resolve(value: string | null): void }
  | { id: number; kind: "confirm"; options: ConfirmDialogOptions; resolve(value: boolean): void };

const OperatorDialogContext = createContext<OperatorDialogApi | null>(null);

export function OperatorDialogProvider({ children }: PropsWithChildren) {
  const nextId = useRef(0);
  const activeRef = useRef<PendingDialog | null>(null);
  const queue = useRef<PendingDialog[]>([]);
  const [active, setActive] = useState<PendingDialog | null>(null);

  const enqueue = useCallback((request: PendingDialog) => {
    if (activeRef.current) {
      queue.current.push(request);
      return;
    }
    activeRef.current = request;
    setActive(request);
  }, []);

  const prompt = useCallback((options: PromptDialogOptions) => new Promise<string | null>((resolve) => {
    enqueue({ id: ++nextId.current, kind: "prompt", options, resolve });
  }), [enqueue]);

  const confirm = useCallback((options: ConfirmDialogOptions) => new Promise<boolean>((resolve) => {
    enqueue({ id: ++nextId.current, kind: "confirm", options, resolve });
  }), [enqueue]);

  const finish = useCallback((result: string | null | boolean) => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    if (current.kind === "prompt") current.resolve(typeof result === "string" ? result : null);
    else current.resolve(result === true);
    const following = queue.current.shift() ?? null;
    activeRef.current = following;
    setActive(following);
  }, []);

  const api = useMemo(() => ({ prompt, confirm }), [confirm, prompt]);

  return <OperatorDialogContext.Provider value={api}>
    {children}
    {active && <OperatorDialog key={active.id} request={active} onFinish={finish} />}
  </OperatorDialogContext.Provider>;
}

export function useOperatorDialog(): OperatorDialogApi {
  const context = useContext(OperatorDialogContext);
  if (!context) throw new Error("useOperatorDialog must be used within OperatorDialogProvider");
  return context;
}

function OperatorDialog({ request, onFinish }: { request: PendingDialog; onFinish(result: string | null | boolean): void }) {
  const options = request.options;
  const [value, setValue] = useState(request.kind === "prompt" ? request.options.defaultValue ?? "" : "");
  const confirmLabel = options.confirmLabel ?? (request.kind === "confirm" ? "Confirm" : "Continue");
  const promptIsEmpty = request.kind === "prompt" && value.trim().length === 0;

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onFinish(request.kind === "prompt" ? null : false); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content operator-dialog">
        <Dialog.Title>{options.title}</Dialog.Title>
        <Dialog.Description>{options.description}</Dialog.Description>
        <form className="dialog-form" onSubmit={(event) => {
          event.preventDefault();
          if (request.kind === "prompt") {
            if (!value.trim()) return;
            onFinish(value);
          } else {
            onFinish(true);
          }
        }}>
          {request.kind === "prompt" && <Field label={request.options.label}>
            {request.options.multiline
              ? <Textarea autoFocus value={value} onChange={(event) => setValue(event.target.value)} rows={7} required />
              : <Input autoFocus value={value} onChange={(event) => setValue(event.target.value)} required />}
          </Field>}
          <div className="dialog-actions">
            <Button type="button" variant="ghost" onClick={() => onFinish(request.kind === "prompt" ? null : false)}>Cancel</Button>
            <Button type="submit" variant={request.kind === "confirm" && request.options.danger ? "danger" : "primary"} disabled={promptIsEmpty}>{confirmLabel}</Button>
          </div>
        </form>
        <button type="button" className="dialog-close" aria-label="Close" onClick={() => onFinish(request.kind === "prompt" ? null : false)}><X size={17} /></button>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
