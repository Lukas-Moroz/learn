import { useEffect, useId, useState } from "react";

/**
 * Renders validated Mermaid source client-side. A diagram that fails to parse is
 * never shown half-broken: the reader gets the caption and a note instead.
 */
export function Mermaid({ source, caption }: { source: string; caption: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
        await mermaid.parse(source);
        const { svg } = await mermaid.render(`m${id}`, source);
        if (!cancelled) setSvg(svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, id]);

  return (
    <figure className="diagram">
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : failed ? <p className="muted small">This diagram could not be drawn, so it is left out rather than shown incorrectly.</p> : <div className="spinner" style={{ margin: "1rem auto" }} />}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
