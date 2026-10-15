import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../api.ts";
import { Modal } from "./Modal.tsx";

export interface SourceTarget {
  sourceId: string;
  page: number;
  quote?: string;
  label?: string | null;
}

type PageInfo = { text: string; pageCount: number; unit: string; kind: string; filename: string };
const WIDE = "(min-width: 1100px)";
const PIN_KEY = "learn:sourcePinned";

function readPinned() {
  try {
    return localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

/**
 * Original-source panel: renders the PDF page (PDF.js) or the extracted slide text.
 * A modal drawer by default; on wide screens it can be pinned beside the lesson as a non-modal split view.
 */
export function SourceDrawer({ target, onClose }: { target: SourceTarget; onClose: () => void }) {
  const [page, setPage] = useState(target.page);
  const [info, setInfo] = useState<PageInfo | null>(null);
  const [load, setLoad] = useState<"loading" | "error" | "ok">("loading");
  const [attempt, setAttempt] = useState(0);
  const [showText, setShowText] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const [pinned, setPinned] = useState(readPinned);
  const wide = useMedia(WIDE);
  const docked = pinned && wide;
  const canvas = useRef<HTMLCanvasElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const pinBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const toggled = useRef(false);

  useEffect(() => setPage(target.page), [target.page, target.sourceId]);

  useEffect(() => {
    let stale = false;
    setLoad("loading");
    api
      .page(target.sourceId, page)
      .then((r) => {
        if (stale) return;
        setInfo(r);
        setLoad("ok");
      })
      .catch(() => !stale && setLoad("error"));
    return () => {
      stale = true;
    };
  }, [target.sourceId, page, attempt]);

  useEffect(() => {
    if (!info || info.kind !== "pdf" || showText) return;
    let cancelled = false;
    setRenderError(false);
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const doc = await pdfjs.getDocument({ url: `/api/sources/${target.sourceId}/file` }).promise;
        const p = await doc.getPage(page);
        const viewport = p.getViewport({ scale: 2 });
        const c = canvas.current;
        if (!c || cancelled) return;
        c.width = viewport.width;
        c.height = viewport.height;
        await p.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport }).promise;
      } catch {
        if (!cancelled) setRenderError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `docked` remounts the canvas, so it needs a fresh render.
  }, [info, page, target.sourceId, showText, docked]);

  // Split view: make room for the docked panel beside the lesson.
  useEffect(() => {
    if (!docked) return;
    document.body.classList.add("source-pinned");
    return () => document.body.classList.remove("source-pinned");
  }, [docked]);

  // Docked panel isn't a modal, so it handles its own initial focus; after a pin toggle keep focus on the toggle.
  useEffect(() => {
    if (toggled.current) pinBtn.current?.focus();
    else if (docked) closeBtn.current?.focus();
    toggled.current = false;
  }, [docked]);

  // On close, return focus to whatever opened the panel if it was lost (after Modal has lifted `inert`).
  useEffect(
    () => () => {
      setTimeout(() => {
        if ((!document.activeElement || document.activeElement === document.body) && opener.current?.isConnected) opener.current.focus();
      });
    },
    [],
  );

  const togglePin = () => {
    toggled.current = true;
    setPinned(!docked);
    try {
      localStorage.setItem(PIN_KEY, docked ? "0" : "1");
    } catch {
      // per-viewer convenience only
    }
  };

  // ←/→ page through the source while focus is in the panel, but never while typing.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape" && docked) return onClose();
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === "ArrowRight" && info) {
      e.preventDefault();
      setPage((p) => Math.min(info.pageCount, p + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPage((p) => Math.max(1, p - 1));
    }
  };

  const unit = info?.unit ?? "page";
  const content = (
    <>
      <div className="drawer-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="kicker">Original source</div>
          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {info?.filename ?? "…"} · {unit} {page}
            {info ? ` of ${info.pageCount}` : ""}
          </div>
        </div>
        <button className="btn small" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label={`Previous ${unit}`}>
          <span aria-hidden>←</span>
        </button>
        <button className="btn small" onClick={() => setPage((p) => (info ? Math.min(info.pageCount, p + 1) : p))} disabled={!info || page >= info.pageCount} aria-label={`Next ${unit}`}>
          <span aria-hidden>→</span>
        </button>
        {info?.kind === "pdf" && (
          <button className="btn small ghost" onClick={() => setShowText((s) => !s)}>
            {showText ? "Page image" : "Text"}
          </button>
        )}
        {wide && (
          <button ref={pinBtn} className="btn small ghost pin" onClick={togglePin} aria-pressed={docked} aria-label="Pin beside lesson" title={docked ? "Unpin: show as an overlay" : "Pin beside lesson"}>
            Pin
          </button>
        )}
        <button ref={closeBtn} className="btn small" onClick={onClose} aria-label="Close source panel">
          <span aria-hidden>✕</span>
        </button>
      </div>
      <div className="drawer-body">
        {target.quote && page === target.page && (
          <p className="small" style={{ marginTop: 0 }}>
            <span className="kicker">Cited passage</span>
            <br />“{target.quote}”
          </p>
        )}
        {load === "error" ? (
          <div className="banner bad small" role="alert">
            <span style={{ flex: 1 }}>
              Could not load {unit} {page}. Check that Learn is still running, then try again.
            </span>
            <button className="btn small" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </button>
          </div>
        ) : !info ? (
          <div className="working" aria-live="polite">
            <span className="spinner" aria-hidden />
            Loading {unit}…
          </div>
        ) : info.kind === "pdf" && !showText && !renderError ? (
          <canvas ref={canvas} className="pdf-canvas" aria-label={`${unit} ${page} of the source`} />
        ) : (
          <div className="page-text" aria-busy={load === "loading"}>
            {info.text || <span className="muted">No text on this {unit}.</span>}
          </div>
        )}
        {renderError && load !== "error" && <p className="muted small">The page image could not be rendered; showing extracted text.</p>}
      </div>
    </>
  );

  return docked ? (
    <aside className="drawer docked" aria-label="Original source" tabIndex={-1} onKeyDown={onKeyDown}>
      {content}
    </aside>
  ) : (
    <Modal label="Original source" className="drawer" onClose={onClose} initialFocus={closeBtn} onKeyDown={onKeyDown}>
      {content}
    </Modal>
  );
}
