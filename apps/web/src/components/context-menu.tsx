import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuPoint {
  x: number;
  y: number;
}

interface ContextMenuProps {
  point: ContextMenuPoint;
  label: string;
  children: ReactNode;
  onClose(): void;
}

const VIEWPORT_GAP = 8;

function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter((item) => !item.hasAttribute("disabled"));
}

export function ContextMenu({ point, label, children, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(point);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(VIEWPORT_GAP, Math.min(point.x, window.innerWidth - bounds.width - VIEWPORT_GAP)),
      y: Math.max(VIEWPORT_GAP, Math.min(point.y, window.innerHeight - bounds.height - VIEWPORT_GAP))
    });
    const frame = window.requestAnimationFrame(() => menuItems(menu)[0]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [point.x, point.y]);

  useEffect(() => {
    const dismissOutside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as globalThis.Node)) onClose();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("contextmenu", dismissOutside, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("contextmenu", dismissOutside, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const items = menuItems(event.currentTarget);
    if (items.length === 0) return;
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    let next: number | null = null;
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) next = (current + 1) % items.length;
    if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) next = (current - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return createPortal(<div
    ref={menuRef}
    className="context-menu"
    role="menu"
    aria-label={label}
    style={{ left: position.x, top: position.y }}
    onKeyDown={navigate}
    onContextMenu={(event) => event.preventDefault()}
  >
    {children}
  </div>, document.body);
}
