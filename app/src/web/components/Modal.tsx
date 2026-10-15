import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const stack: HTMLElement[] = [];

/** Elements Tab can actually reach: rendered, and only the checked radio of a group that has one. */
function tabbable(box: HTMLElement) {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.offsetParent === null && el !== document.activeElement) return false;
    if (el instanceof HTMLInputElement && el.type === "radio" && !el.checked && el.name)
      return !box.querySelector(`input[type=radio][name="${CSS.escape(el.name)}"]:checked`);
    return true;
  });
}

/**
 * Accessible modal (W3C APG dialog pattern): portalled outside #root, which is made inert while open;
 * initial focus, Tab contained in the dialog, Escape closes, and focus returns to the opener on close.
 */
export function Modal({
  label,
  className,
  onClose,
  initialFocus,
  onKeyDown: onKey,
  children,
}: {
  label: string;
  className: "dialog" | "drawer";
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = box.current!;
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    stack.push(el);
    root?.setAttribute("inert", "");
    (initialFocus?.current ?? tabbable(el)[0] ?? el).focus();
    // Escape also works when focus has fallen to <body> (e.g. the focused control was removed).
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && stack[stack.length - 1] === el && !el.contains(e.target as Node)) close.current();
    };
    document.addEventListener("keydown", onDocKey);
    return () => {
      document.removeEventListener("keydown", onDocKey);
      stack.splice(stack.indexOf(el), 1);
      if (stack.length === 0) root?.removeAttribute("inert");
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKey?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close.current();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = tabbable(box.current);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const outside = active === box.current || !box.current.contains(active);
    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={() => close.current()} />
      <div ref={box} className={className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </>,
    document.body,
  );
}
