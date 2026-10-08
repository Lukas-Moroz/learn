// Text extraction per page (PDF) or per slide (PPTX). Pure and local: no AI.
import JSZip from "jszip";

export const extractionStats = { pdf: 0, pptx: 0 };

export async function extractPdf(data: Uint8Array): Promise<string[]> {
  extractionStats.pdf++;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== "string") continue;
        text += item.str + (item.hasEOL ? "\n" : " ");
      }
      pages.push(text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim());
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/** Slide text in slide order, plus speaker notes. */
export async function extractPptx(data: Uint8Array): Promise<string[]> {
  extractionStats.pptx++;
  const zip = await JSZip.loadAsync(data);
  const slideNum = (p: string) => Number(/slide(\d+)\.xml$/.exec(p)?.[1] ?? 0);
  const slides = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNum(a) - slideNum(b));
  const textOf = (xml: string) =>
    xml
      .split(/<\/a:p>/)
      .map((para) => [...para.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join(""))
      .filter((l) => l.trim())
      .join("\n");
  const out: string[] = [];
  for (const s of slides) {
    let text = textOf(await zip.file(s)!.async("string"));
    const notes = zip.file(`ppt/notesSlides/notesSlide${slideNum(s)}.xml`);
    if (notes) {
      const n = textOf(await notes.async("string")).replace(/^\d+$/m, "").trim();
      if (n) text += `\n\nSpeaker notes:\n${n}`;
    }
    out.push(text.trim());
  }
  return out;
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
