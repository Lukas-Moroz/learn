// Incremental reading of a JSON object that is still streaming in, for live previews.
// Given the text received so far, returns the current (possibly incomplete) values of named
// top-level string fields. Purely a display aid: nothing read here is ever validated or
// committed; the finished response still goes through the schema like any other.

export interface PartialFields {
  /** Field name → its text so far (decoded: escapes resolved). Only fields seen so far appear. */
  values: Record<string, string>;
  /** The field whose string value is still open at the end of the text, if any. */
  open: string | null;
}

const ESC: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * Read a JSON string starting just after its opening quote. Returns the decoded text and the
 * index after the closing quote, or `end: null` when the text stops before the string closes.
 * A cut-off escape (a lone "\", or "\u12") is dropped, and so is a high surrogate whose pair
 * has not arrived yet, so the preview never shows half a character.
 */
function readString(s: string, i: number, decode: boolean): { text: string; end: number | null } {
  let out = "";
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') return { text: out, end: i + 1 };
    if (ch !== "\\") {
      if (decode) out += ch;
      i++;
      continue;
    }
    const e = s[i + 1];
    if (e === undefined) return { text: out, end: null }; // cut mid-escape
    if (e === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (hex.length < 4) return { text: out, end: null };
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        i += 2; // malformed: skip the escape, keep going
        continue;
      }
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        // A high surrogate needs its low half before it can be shown.
        const rest = s.slice(i + 6, i + 12);
        if (rest.length < 6 && /^(?:\\(?:u(?:[dD](?:[c-fC-F][0-9a-fA-F]{0,2})?)?)?)?$/.test(rest)) return { text: out, end: null };
        const low = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(rest);
        if (low) {
          if (decode) out += String.fromCharCode(code, parseInt(low[1], 16));
          i += 12;
          continue;
        }
        i += 6; // unpaired: drop it
        continue;
      }
      if (decode) out += String.fromCharCode(code);
      i += 6;
      continue;
    }
    if (decode) out += ESC[e] ?? e;
    i += 2;
  }
  return { text: out, end: null };
}

/** Skip one JSON value of any type (strings, nested objects/arrays, literals). Returns the index after it, or null if cut off. */
function skipValue(s: string, i: number): number | null {
  let depth = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      const r = readString(s, i + 1, false);
      if (r.end === null) return null;
      i = r.end;
      if (depth === 0) return i;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (depth === 0) return i; // the enclosing object ends: a literal just finished
      depth--;
      if (depth === 0) return i + 1;
    } else if (depth === 0 && ch === ",") return i;
    i++;
  }
  return null;
}

const WS = /\s/;

/**
 * Current values of the named top-level string fields of a streaming JSON object. Text before
 * the first "{" (a code fence, a stray word) is ignored. A later duplicate key wins, as in JSON.parse.
 * A dotted name ("check.stem") reads a string field of a nested object; it is reported under
 * that dotted name.
 */
export function partialFields(text: string, fields: readonly string[]): PartialFields {
  const want = new Set(fields.filter((f) => !f.includes(".")));
  const nested = new Map<string, string[]>();
  for (const f of fields) {
    const dot = f.indexOf(".");
    if (dot > 0) nested.set(f.slice(0, dot), [...(nested.get(f.slice(0, dot)) ?? []), f.slice(dot + 1)]);
  }
  const values: Record<string, string> = {};
  let i = text.indexOf("{");
  if (i < 0) return { values, open: null };
  i++;
  const s = text;
  for (;;) {
    while (i < s.length && (WS.test(s[i]) || s[i] === ",")) i++;
    if (i >= s.length || s[i] === "}") return { values, open: null };
    if (s[i] !== '"') return { values, open: null }; // not JSON we understand: stop quietly
    const key = readString(s, i + 1, true);
    if (key.end === null) return { values, open: null };
    i = key.end;
    while (i < s.length && WS.test(s[i])) i++;
    if (s[i] !== ":") return { values, open: null };
    i++;
    while (i < s.length && WS.test(s[i])) i++;
    if (i >= s.length) return { values, open: null };
    if (s[i] === "{" && nested.has(key.text)) {
      const inner = partialFields(s.slice(i), nested.get(key.text)!);
      for (const [k, v] of Object.entries(inner.values)) values[`${key.text}.${k}`] = v;
      const next = skipValue(s, i);
      if (next === null) return { values, open: inner.open ? `${key.text}.${inner.open}` : null };
      i = next;
      continue;
    }
    if (s[i] === '"' && want.has(key.text)) {
      const v = readString(s, i + 1, true);
      values[key.text] = v.text;
      if (v.end === null) return { values, open: key.text };
      i = v.end;
      continue;
    }
    const next = skipValue(s, i);
    if (next === null) return { values, open: null };
    i = next;
  }
}

/**
 * The open field's text without its trailing partial word (a number or word still being typed),
 * so a preview never shows "12" of what becomes "125". Whole text when it ends at a break.
 */
export function settledText(text: string): string {
  if (!text || /[\s.,;:!?)\]}]$/.test(text)) return text;
  const cut = text.search(/\S+$/);
  return cut > 0 ? text.slice(0, cut) : "";
}

/**
 * Markdown that is safe to render while it is still being written: an unterminated trailing
 * $…$ or $$…$$ span is hidden until it closes (KaTeX would otherwise show raw or broken TeX),
 * and an open ``` fence is closed so the rest of the text doesn't turn into code.
 */
export function previewMarkdown(text: string): string {
  let mathStart = -1;
  let display = false;
  let fence = false;
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const lineStart = i === 0 || text[i - 1] === "\n";
    if (lineStart && /^[ \t]{0,3}```/.test(text.slice(i, i + 6)) && mathStart < 0) {
      fence = !fence;
      i = text.indexOf("```", i) + 2;
      continue;
    }
    if (fence) continue;
    if (ch === "\\") {
      i++; // an escaped character (e.g. \$) never delimits
      continue;
    }
    if (ch === "`" && mathStart < 0) {
      code = !code;
      continue;
    }
    if (code || ch !== "$") continue;
    const double = text[i + 1] === "$";
    if (mathStart < 0) {
      mathStart = i;
      display = double;
      if (double) i++;
    } else if (display ? double : true) {
      mathStart = -1;
      if (display) i++;
    }
  }
  let out = mathStart >= 0 ? text.slice(0, mathStart).replace(/[ \t]+$/, "") : text;
  if (fence) out += "\n```";
  return out;
}
