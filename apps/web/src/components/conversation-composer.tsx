import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type PointerEvent,
  type ReactNode,
  type TextareaHTMLAttributes
} from "react";

export const COMPOSER_HEIGHT_STORAGE_KEY = "lathe.composer-height.v1";
export const DEFAULT_COMPOSER_HEIGHT = 150;
export const MIN_COMPOSER_HEIGHT = 112;
export const MAX_COMPOSER_HEIGHT = 520;
export const MIN_TRANSCRIPT_HEIGHT = 180;
const COMPOSER_RESIZE_STEP = 16;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function readComposerHeight(storage?: Pick<Storage, "getItem">): number {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return DEFAULT_COMPOSER_HEIGHT;
    const raw = source.getItem(COMPOSER_HEIGHT_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return DEFAULT_COMPOSER_HEIGHT;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? clamp(Math.round(parsed), MIN_COMPOSER_HEIGHT, MAX_COMPOSER_HEIGHT)
      : DEFAULT_COMPOSER_HEIGHT;
  } catch {
    return DEFAULT_COMPOSER_HEIGHT;
  }
}

export function fitComposerHeight(preferredHeight: number, containerHeight: number): { height: number; maximum: number } {
  const maximum = containerHeight > 0
    ? Math.max(MIN_COMPOSER_HEIGHT, Math.min(MAX_COMPOSER_HEIGHT, Math.round(containerHeight - MIN_TRANSCRIPT_HEIGHT)))
    : MAX_COMPOSER_HEIGHT;
  return { height: clamp(Math.round(preferredHeight), MIN_COMPOSER_HEIGHT, maximum), maximum };
}

interface ComposerPanelProps {
  children: ReactNode;
}

interface ComposerDragState {
  pointerId: number;
  startClientY: number;
  startHeight: number;
}

export function ComposerPanel({ children }: ComposerPanelProps) {
  const [preferredHeight, setPreferredHeight] = useState(readComposerHeight);
  const [containerHeight, setContainerHeight] = useState(0);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ComposerDragState | null>(null);
  const fitted = useMemo(() => fitComposerHeight(preferredHeight, containerHeight), [containerHeight, preferredHeight]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(preferredHeight));
    } catch {
      // The composer remains resizable when local storage is unavailable.
    }
  }, [preferredHeight]);

  useEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setContainerHeight(Math.round(parent.getBoundingClientRect().height || parent.clientHeight));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const setClampedHeight = (nextHeight: number) => {
    setPreferredHeight(clamp(Math.round(nextHeight), MIN_COMPOSER_HEIGHT, fitted.maximum));
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = { pointerId: event.pointerId, startClientY: event.clientY, startHeight: fitted.height };
    setResizing(true);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setClampedHeight(drag.startHeight + drag.startClientY - event.clientY);
  };
  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? COMPOSER_RESIZE_STEP * 3 : COMPOSER_RESIZE_STEP;
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") nextHeight = fitted.height + step;
    if (event.key === "ArrowDown") nextHeight = fitted.height - step;
    if (event.key === "Home") nextHeight = MIN_COMPOSER_HEIGHT;
    if (event.key === "End") nextHeight = fitted.maximum;
    if (nextHeight === null) return;
    event.preventDefault();
    setClampedHeight(nextHeight);
  };

  const style = { "--composer-height": `${fitted.height}px` } as CSSProperties;
  return <div ref={panelRef} className="composer" style={style} data-resizing={resizing || undefined}>
    <div
      className="composer-resize-handle"
      role="separator"
      aria-label="Resize message composer"
      aria-orientation="horizontal"
      aria-controls="operator-composer-input"
      aria-valuemin={MIN_COMPOSER_HEIGHT}
      aria-valuemax={fitted.maximum}
      aria-valuenow={fitted.height}
      tabIndex={0}
      title="Drag to resize · Double-click to reset"
      onPointerDown={beginResize}
      onPointerMove={continueResize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => setClampedHeight(DEFAULT_COMPOSER_HEIGHT)}
    />
    {children}
  </div>;
}

export type ComposerValueOrigin = "input" | "history" | "draft";

export interface ComposerHistoryEntry {
  text: string;
  sourcePayloadRevisionId: string | null;
}

type ComposerDraft = ComposerHistoryEntry;

interface ComposerTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  sourcePayloadRevisionId: string | null;
  history: readonly ComposerHistoryEntry[];
  navigationKey: string;
  onValueChange(value: string, origin: ComposerValueOrigin, sourcePayloadRevisionId: string | null): void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
}

export function ComposerTextarea({ value, sourcePayloadRevisionId, history, navigationKey, onValueChange, onKeyDown, className, ...props }: ComposerTextareaProps) {
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef<ComposerDraft>({ text: value, sourcePayloadRevisionId });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setHistoryIndex(null);
    draftRef.current = { text: value, sourcePayloadRevisionId };
  }, [navigationKey]);

  useEffect(() => {
    if (historyIndex === null) {
      draftRef.current = { text: value, sourcePayloadRevisionId };
      return;
    }
    const entry = history[historyIndex];
    if (!entry || value !== entry.text || sourcePayloadRevisionId !== entry.sourcePayloadRevisionId) {
      setHistoryIndex(null);
      draftRef.current = { text: value, sourcePayloadRevisionId };
    }
  }, [history, historyIndex, sourcePayloadRevisionId, value]);

  const placeCaret = (position: number) => {
    const apply = () => textareaRef.current?.setSelectionRange(position, position);
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(apply);
    else queueMicrotask(apply);
  };

  const navigateHistory = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const textarea = event.currentTarget;
    if (textarea.selectionStart !== textarea.selectionEnd) return false;

    const enteringHistory = historyIndex === null;
    if (event.key === "ArrowUp" && history.length > 0 && (!enteringHistory || textarea.selectionStart === 0)) {
      if (enteringHistory) draftRef.current = { text: value, sourcePayloadRevisionId };
      const nextIndex = enteringHistory ? history.length - 1 : Math.max(0, historyIndex - 1);
      const entry = history[nextIndex];
      if (!entry) return false;
      event.preventDefault();
      setHistoryIndex(nextIndex);
      onValueChange(entry.text, "history", entry.sourcePayloadRevisionId);
      placeCaret(0);
      return true;
    }

    if (event.key === "ArrowDown" && historyIndex !== null) {
      event.preventDefault();
      if (historyIndex < history.length - 1) {
        const nextIndex = historyIndex + 1;
        const entry = history[nextIndex];
        if (entry) {
          setHistoryIndex(nextIndex);
          onValueChange(entry.text, "history", entry.sourcePayloadRevisionId);
          placeCaret(entry.text.length);
        }
      } else {
        const draft = draftRef.current;
        setHistoryIndex(null);
        onValueChange(draft.text, "draft", draft.sourcePayloadRevisionId);
        placeCaret(draft.text.length);
      }
      return true;
    }
    return false;
  };

  return <textarea
    {...props}
    ref={textareaRef}
    className={`textarea ${className ?? ""}`}
    value={value}
    onChange={(event) => {
      setHistoryIndex(null);
      draftRef.current = { text: event.target.value, sourcePayloadRevisionId };
      onValueChange(event.target.value, "input", sourcePayloadRevisionId);
    }}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (!event.defaultPrevented) navigateHistory(event);
    }}
  />;
}
