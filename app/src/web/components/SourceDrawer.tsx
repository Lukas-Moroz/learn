import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

export interface SourceTarget {
  sourceId: string;
  page: number;
  quote?: string;
  label?: string | null;
}

/** Expandable original-source panel: renders the PDF page (PDF.js) or the extracted slide text. */
export function SourceDrawer({ target, onClose }: { target: SourceTarget; onClose: () => void }) {
  const [page, setPage] = useState(target.page);
  const [info, setInfo] = useState<{ text: string; pageCount: number; unit: string; kind: string; filename: string } | null>(null);
  const [showText, setShowText] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => setPage(target.page), [target.page, target.sourceId]);
  useEffect(() => closeBtn.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && info) setPage((p) => Math.min(info.pageCount, p + 1));
      if (e.key === "ArrowLeft") setPage((p) => Math.max(1, p - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, info]);

  useEffect(() => {
    api.page(target.sourceId, page).then(setInfo).catch(() => setInfo(null));
  }, [target.sourceId, page]);

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
  }, [info, page, target.sourceId, showText]);

  const unit = info?.unit ?? "page";
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Original source">
        <div className="drawer-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="kicker">Original source</div>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {info?.filename ?? "…"} · {unit} {page}
              {info ? ` of ${info.pageCount}` : ""}
            </div>
          </div>
          <button className="btn small" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label={`Previous ${unit}`}>
            ←
          </button>
          <button className="btn small" onClick={() => setPage((p) => (info ? Math.min(info.pageCount, p + 1) : p))} disabled={!info || page >= info.pageCount} aria-label={`Next ${unit}`}>
            →
          </button>
          {info?.kind === "pdf" && (
            <button className="btn small ghost" onClick={() => setShowText((s) => !s)}>
              {showText ? "Page image" : "Text"}
            </button>
          )}
          <button ref={closeBtn} className="btn small" onClick={onClose} aria-label="Close source panel">
            ✕
          </button>
        </div>
        <div className="drawer-body">
          {target.quote && page === target.page && (
            <p className="small" style={{ marginTop: 0 }}>
              <span className="kicker">Cited passage</span>
              <br />“{target.quote}”
            </p>
          )}
          {info?.kind === "pdf" && !showText && !renderError ? (
            <canvas ref={canvas} className="pdf-canvas" aria-label={`${unit} ${page} of the source`} />
          ) : (
            <div className="page-text">{info?.text || "No text on this page."}</div>
          )}
          {renderError && <p className="muted small">The page image could not be rendered; showing extracted text.</p>}
        </div>
      </aside>
    </>
  );
}
