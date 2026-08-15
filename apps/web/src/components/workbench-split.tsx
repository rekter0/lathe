import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

export const WORKBENCH_LAYOUT_STORAGE_KEY = "lathe.workbench-layout.v1";
export const DEFAULT_LEFT_PANE_WIDTH = 280;
export const DEFAULT_RIGHT_PANE_WIDTH = 390;
export const MIN_LEFT_PANE_WIDTH = 180;
export const MIN_RIGHT_PANE_WIDTH = 320;
export const MAX_LEFT_PANE_WIDTH = 640;
export const MAX_RIGHT_PANE_WIDTH = 720;
export const MIN_TRANSCRIPT_WIDTH = 420;
export const COLLAPSED_PANE_WIDTH = 38;
const RESIZE_HANDLE_WIDTH = 6;

export interface WorkbenchLayoutPreferences {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export const defaultWorkbenchLayout: WorkbenchLayoutPreferences = {
  leftWidth: DEFAULT_LEFT_PANE_WIDTH,
  rightWidth: DEFAULT_RIGHT_PANE_WIDTH,
  leftCollapsed: false,
  rightCollapsed: false
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), minimum, maximum) : fallback;
}

export function readWorkbenchLayout(storage?: Pick<Storage, "getItem">): WorkbenchLayoutPreferences {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return { ...defaultWorkbenchLayout };
    const value = source.getItem(WORKBENCH_LAYOUT_STORAGE_KEY);
    if (!value) return { ...defaultWorkbenchLayout };
    const parsed = JSON.parse(value) as Partial<WorkbenchLayoutPreferences>;
    return {
      leftWidth: finiteNumber(parsed.leftWidth, DEFAULT_LEFT_PANE_WIDTH, MIN_LEFT_PANE_WIDTH, MAX_LEFT_PANE_WIDTH),
      rightWidth: finiteNumber(parsed.rightWidth, DEFAULT_RIGHT_PANE_WIDTH, MIN_RIGHT_PANE_WIDTH, MAX_RIGHT_PANE_WIDTH),
      leftCollapsed: parsed.leftCollapsed === true,
      rightCollapsed: parsed.rightCollapsed === true
    };
  } catch {
    return { ...defaultWorkbenchLayout };
  }
}

export function fitWorkbenchPanelWidths(preferences: WorkbenchLayoutPreferences, containerWidth: number): { leftWidth: number; rightWidth: number } {
  let leftWidth = preferences.leftCollapsed
    ? COLLAPSED_PANE_WIDTH
    : clamp(preferences.leftWidth, MIN_LEFT_PANE_WIDTH, MAX_LEFT_PANE_WIDTH);
  let rightWidth = preferences.rightCollapsed
    ? COLLAPSED_PANE_WIDTH
    : clamp(preferences.rightWidth, MIN_RIGHT_PANE_WIDTH, MAX_RIGHT_PANE_WIDTH);
  if (containerWidth <= 0) return { leftWidth, rightWidth };

  const handles = (preferences.leftCollapsed ? 0 : RESIZE_HANDLE_WIDTH) + (preferences.rightCollapsed ? 0 : RESIZE_HANDLE_WIDTH);
  const panelBudget = Math.max(0, containerWidth - MIN_TRANSCRIPT_WIDTH - handles);
  let excess = leftWidth + rightWidth - panelBudget;
  if (excess <= 0) return { leftWidth, rightWidth };

  const leftCapacity = preferences.leftCollapsed ? 0 : leftWidth - MIN_LEFT_PANE_WIDTH;
  const rightCapacity = preferences.rightCollapsed ? 0 : rightWidth - MIN_RIGHT_PANE_WIDTH;
  const totalCapacity = leftCapacity + rightCapacity;
  if (totalCapacity > 0) {
    const leftReduction = Math.min(leftCapacity, Math.round(excess * leftCapacity / totalCapacity));
    leftWidth -= leftReduction;
    excess -= leftReduction;
    const rightReduction = Math.min(rightCapacity, excess);
    rightWidth -= rightReduction;
    excess -= rightReduction;
    if (excess > 0) leftWidth -= Math.min(leftWidth - MIN_LEFT_PANE_WIDTH, excess);
  }
  return { leftWidth, rightWidth };
}

interface WorkbenchSplitProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

type PaneSide = "left" | "right";

interface DragState {
  side: PaneSide;
  pointerId: number;
  startClientX: number;
  startWidth: number;
}

export function WorkbenchSplit({ left, center, right }: WorkbenchSplitProps) {
  const [preferences, setPreferences] = useState(readWorkbenchLayout);
  const [containerWidth, setContainerWidth] = useState(0);
  const [resizing, setResizing] = useState<PaneSide | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const fitted = useMemo(() => fitWorkbenchPanelWidths(preferences, containerWidth), [containerWidth, preferences]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Local storage can be unavailable without preventing panel interaction.
    }
  }, [preferences]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(Math.round(element.getBoundingClientRect().width || element.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const maximumFor = (side: PaneSide, current: WorkbenchLayoutPreferences): number => {
    if (containerWidth <= 0) return side === "left" ? MAX_LEFT_PANE_WIDTH : MAX_RIGHT_PANE_WIDTH;
    const currentFitted = fitWorkbenchPanelWidths(current, containerWidth);
    const otherWidth = side === "left" ? currentFitted.rightWidth : currentFitted.leftWidth;
    const handles = (current.leftCollapsed ? 0 : RESIZE_HANDLE_WIDTH) + (current.rightCollapsed ? 0 : RESIZE_HANDLE_WIDTH);
    const absoluteMaximum = side === "left" ? MAX_LEFT_PANE_WIDTH : MAX_RIGHT_PANE_WIDTH;
    const minimum = side === "left" ? MIN_LEFT_PANE_WIDTH : MIN_RIGHT_PANE_WIDTH;
    return Math.max(minimum, Math.min(absoluteMaximum, containerWidth - otherWidth - handles - MIN_TRANSCRIPT_WIDTH));
  };

  const setPaneWidth = (side: PaneSide, width: number) => {
    setPreferences((current) => {
      const minimum = side === "left" ? MIN_LEFT_PANE_WIDTH : MIN_RIGHT_PANE_WIDTH;
      const nextWidth = clamp(Math.round(width), minimum, maximumFor(side, current));
      return side === "left" ? { ...current, leftWidth: nextWidth } : { ...current, rightWidth: nextWidth };
    });
  };

  const beginResize = (side: PaneSide, event: PointerEvent<HTMLDivElement>) => {
    if (side === "left" ? preferences.leftCollapsed : preferences.rightCollapsed) return;
    dragRef.current = {
      side,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: side === "left" ? fitted.leftWidth : fitted.rightWidth
    };
    setResizing(side);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.side === "left" ? event.clientX - drag.startClientX : drag.startClientX - event.clientX;
    setPaneWidth(drag.side, drag.startWidth + delta);
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setResizing(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resizeWithKeyboard = (side: PaneSide, event: KeyboardEvent<HTMLDivElement>) => {
    const currentWidth = side === "left" ? fitted.leftWidth : fitted.rightWidth;
    const minimum = side === "left" ? MIN_LEFT_PANE_WIDTH : MIN_RIGHT_PANE_WIDTH;
    const maximum = maximumFor(side, preferences);
    const step = event.shiftKey ? 48 : 16;
    let nextWidth: number | null = null;
    if (event.key === "Home") nextWidth = minimum;
    if (event.key === "End") nextWidth = maximum;
    if (event.key === "ArrowLeft") nextWidth = currentWidth + (side === "left" ? -step : step);
    if (event.key === "ArrowRight") nextWidth = currentWidth + (side === "left" ? step : -step);
    if (nextWidth === null) return;
    event.preventDefault();
    setPaneWidth(side, nextWidth);
  };

  const togglePane = (side: PaneSide) => setPreferences((current) => side === "left"
    ? { ...current, leftCollapsed: !current.leftCollapsed }
    : { ...current, rightCollapsed: !current.rightCollapsed });

  const resetPane = (side: PaneSide) => setPaneWidth(side, side === "left" ? DEFAULT_LEFT_PANE_WIDTH : DEFAULT_RIGHT_PANE_WIDTH);
  const style = {
    "--tree-pane-width": `${fitted.leftWidth}px`,
    "--inspector-pane-width": `${fitted.rightWidth}px`,
    "--left-resize-width": preferences.leftCollapsed ? "0px" : `${RESIZE_HANDLE_WIDTH}px`,
    "--right-resize-width": preferences.rightCollapsed ? "0px" : `${RESIZE_HANDLE_WIDTH}px`
  } as CSSProperties;

  const leftToggleLabel = preferences.leftCollapsed ? "Expand conversation tree panel" : "Collapse conversation tree panel";
  const rightToggleLabel = preferences.rightCollapsed ? "Expand inspector panel" : "Collapse inspector panel";

  return <div
    ref={containerRef}
    className="workbench-grid"
    style={style}
    data-left-collapsed={preferences.leftCollapsed}
    data-right-collapsed={preferences.rightCollapsed}
    data-resizing={resizing ?? undefined}
  >
    <aside id="conversation-tree-panel" className="tree-pane" aria-label="Conversation tree panel" data-collapsed={preferences.leftCollapsed}>
      <button type="button" className="workbench-pane-toggle pane-toggle-left" aria-label={leftToggleLabel} aria-expanded={!preferences.leftCollapsed} aria-controls="conversation-tree-content" title={leftToggleLabel} onClick={() => togglePane("left")}>
        {preferences.leftCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>
      <div id="conversation-tree-content" className="workbench-pane-content" hidden={preferences.leftCollapsed}>{left}</div>
    </aside>
    <PanelResizeHandle side="left" width={fitted.leftWidth} maximum={maximumFor("left", preferences)} collapsed={preferences.leftCollapsed} onPointerDown={beginResize} onPointerMove={continueResize} onPointerUp={finishResize} onKeyDown={resizeWithKeyboard} onDoubleClick={resetPane} />
    <section className="transcript-pane">{center}</section>
    <PanelResizeHandle side="right" width={fitted.rightWidth} maximum={maximumFor("right", preferences)} collapsed={preferences.rightCollapsed} onPointerDown={beginResize} onPointerMove={continueResize} onPointerUp={finishResize} onKeyDown={resizeWithKeyboard} onDoubleClick={resetPane} />
    <aside id="inspector-panel" className="inspector-pane" aria-label="Inspector panel" data-collapsed={preferences.rightCollapsed}>
      <button type="button" className="workbench-pane-toggle pane-toggle-right" aria-label={rightToggleLabel} aria-expanded={!preferences.rightCollapsed} aria-controls="inspector-content" title={rightToggleLabel} onClick={() => togglePane("right")}>
        {preferences.rightCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
      </button>
      <div id="inspector-content" className="workbench-pane-content" hidden={preferences.rightCollapsed}>{right}</div>
    </aside>
  </div>;
}

interface PanelResizeHandleProps {
  side: PaneSide;
  width: number;
  maximum: number;
  collapsed: boolean;
  onPointerDown(side: PaneSide, event: PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: PointerEvent<HTMLDivElement>): void;
  onPointerUp(event: PointerEvent<HTMLDivElement>): void;
  onKeyDown(side: PaneSide, event: KeyboardEvent<HTMLDivElement>): void;
  onDoubleClick(side: PaneSide): void;
}

function PanelResizeHandle({ side, width, maximum, collapsed, onPointerDown, onPointerMove, onPointerUp, onKeyDown, onDoubleClick }: PanelResizeHandleProps) {
  const label = side === "left" ? "Resize conversation tree panel" : "Resize inspector panel";
  const minimum = side === "left" ? MIN_LEFT_PANE_WIDTH : MIN_RIGHT_PANE_WIDTH;
  return <div
    className={`panel-resize-handle panel-resize-${side}`}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-controls={side === "left" ? "conversation-tree-panel" : "inspector-panel"}
    aria-valuemin={minimum}
    aria-valuemax={Math.round(maximum)}
    aria-valuenow={Math.round(width)}
    aria-hidden={collapsed || undefined}
    tabIndex={collapsed ? -1 : 0}
    title="Drag to resize · Double-click to reset"
    onPointerDown={(event) => onPointerDown(side, event)}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
    onKeyDown={(event) => onKeyDown(side, event)}
    onDoubleClick={() => onDoubleClick(side)}
  />;
}
