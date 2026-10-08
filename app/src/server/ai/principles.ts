// The teaching philosophy has one source of truth: skills/teach/SKILL.md (the pi
// skill). The app extracts the philosophy, both principles and the quiz-option
// construction procedure from it at runtime, so editing the skill changes the app.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const TEACH_SKILL_PATH = process.env.LEARN_TEACH_SKILL ?? join(REPO_ROOT, "skills", "teach", "SKILL.md");

const WANTED = [
  "The philosophy",
  "Principle i",
  "Principle ii",
  "Writing quiz options",
];

/** Extract `## …` / `### …` sections whose heading starts with one of `wanted`. */
export function extractSections(markdown: string, wanted: string[]): string {
  const lines = markdown.replace(/^---[\s\S]*?---\n/, "").split("\n");
  const out: string[] = [];
  let keepLevel = 0;
  for (const line of lines) {
    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (keepLevel && level <= keepLevel) keepLevel = 0;
      if (!keepLevel && wanted.some((w) => h[2].startsWith(w))) keepLevel = level;
    }
    if (keepLevel) out.push(line);
  }
  return out.join("\n").trim();
}

let cache: { mtime: number; text: string } | null = null;

export function teachingPrinciples(): string {
  if (!existsSync(TEACH_SKILL_PATH)) return FALLBACK;
  const text = readFileSync(TEACH_SKILL_PATH, "utf8");
  const mtime = text.length; // cheap change detector; file is small
  if (cache && cache.mtime === mtime) return cache.text;
  // The skill was written for a terminal agent with `quiz` / `ask_user_question` tools and
  // Obsidian rendering. Those mechanics are replaced by the app; the pedagogy is kept.
  const extracted = extractSections(text, WANTED) || FALLBACK;
  cache = { mtime, text: extracted };
  return extracted;
}

const FALLBACK = `## Teaching principles
- Start from unconditional truths the learner can accept at face value; build everything else on them explicitly.
- Make every step feel discovered, not decreed: motivate why the next idea is needed and how someone could have found it.
- Connected knowledge beats disconnected facts: always make the dependency edges explicit.
- Quiz options are bare parallel claims with no justification; distractors are specific real misconceptions.`;
