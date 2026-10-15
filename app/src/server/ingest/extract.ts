// Text extraction per page (PDF) or per slide (PPTX). Pure and local: no AI.
import JSZip from "jszip";

export const extractionStats = { pdf: 0, pptx: 0 };

export async function extractPdf(data: Uint8Array): Promise<string[]> {
  extractionStats.pdf++;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      pages.push(joinTextItems((await page.getTextContent()).items as TextItem[]));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

export interface TextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
}

/**
 * One page's text from pdf.js items. Items that touch on the same baseline are glued: a
 * ligature is often its own item ("Suf" "fi" "x"), as is a word split by a font change.
 * Other boundaries become a space. Some fonts map the space glyph to U+0000, so control
 * characters count as spaces.
 */
export function joinTextItems(items: TextItem[]): string {
  let text = "";
  let prev: TextItem | undefined;
  for (const item of items) {
    if (typeof item.str !== "string" || (!item.str && !item.hasEOL)) continue;
    if (prev && !prev.hasEOL && !touching(prev, item)) text += " ";
    text += item.str.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ") + (item.hasEOL ? "\n" : "");
    prev = item;
  }
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/**
 * b starts where a ends, on a's (horizontal) baseline. Sub/superscripts don't count. Only an
 * effectively zero gap (<= 0.02 em, rounding) glues; a small overlap is allowed for ligature and
 * kerning slop. Any visible gap, even a narrow one between font runs, is a word break.
 */
function touching(a: TextItem, b: TextItem): boolean {
  const [ta, tb] = [a.transform, b.transform];
  if (!ta || !tb || a.width === undefined || Math.abs(ta[1]) > 1e-6 || Math.abs(tb[1]) > 1e-6) return false;
  const size = Math.max(Math.abs(ta[3]), Math.abs(tb[3]));
  const gap = tb[4] - (ta[4] + a.width);
  return Math.abs(tb[5] - ta[5]) <= size * 0.05 && gap >= -size * 0.25 && gap <= size * 0.02;
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
