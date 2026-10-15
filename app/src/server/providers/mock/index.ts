// Deterministic provider for tests and offline development. It answers the same
// prompts a real model gets (parsing the INPUT JSON back out) and streams JSON text,
// so the full generate → validate → commit pipeline is exercised. Failures can be
// injected to test interruption and usage-limit handling.
import { parsePromptInput } from "../../ai/prompts.ts";
import { primaryDimension } from "../../../shared/mastery.ts";
import { ProviderError, type AIProvider, type ProviderStatus, type StreamRequest } from "../types.ts";
import { CURRICULUM, findFixture, slugify, type FixtureConcept } from "./curriculum.ts";
import { followUp } from "./followup.ts";
import { gradePractice, practiceCoach, practiceCoachCheck, practiceOutline, practicePrimer, practiceProblem } from "./practice.ts";

/** "mutate" rewrites the fixture before it is sent (e.g. to produce a malformed table that must be repaired). */
export type InjectedFailure = { task?: string; kind: "interrupt" | "usage_limit" | "invalid" | "billing_risk" | "mutate"; afterChars?: number; mutate?: (out: any) => unknown };

export class MockProvider implements AIProvider {
  readonly id = "mock" as const;
  readonly calls: { task: string; input: any }[] = [];
  private failures: InjectedFailure[] = [];
  /** Simulated per-chunk latency, to make streaming visible in the UI during development. */
  constructor(
    private readonly chunkDelayMs = 0,
    /** Simulated wait before the first token (a real model thinks first), for measuring perceived latency. */
    private readonly firstTokenMs = 0,
  ) {}

  failNext(f: InjectedFailure) {
    this.failures.push(f);
  }

  async status(): Promise<ProviderStatus> {
    return { id: "mock", label: "Mock (deterministic fixtures)", ready: true, state: "ready", message: "Offline fixtures, no AI usage", billing: "none" };
  }

  async listModels() {
    return [{ id: "mock-fixtures", label: "Fixtures" }];
  }

  async stream(req: StreamRequest): Promise<{ text: string }> {
    const { task, input } = parsePromptInput(req.messages[0].content);
    this.calls.push({ task, input });
    const fi = this.failures.findIndex((f) => !f.task || f.task === task);
    const failure = fi >= 0 ? this.failures.splice(fi, 1)[0] : null;
    if (failure?.kind === "usage_limit") throw new ProviderError("usage_limit", "Mock usage limit reached", false, { usageUrl: "https://example.invalid/usage" });
    if (failure?.kind === "billing_risk") throw new ProviderError("billing_risk", "Mock billing risk");

    let out = respond(task, input);
    if (failure?.kind === "mutate" && failure.mutate) out = failure.mutate(structuredClone(out));
    let text = JSON.stringify(out);
    if (failure?.kind === "invalid") text = text.slice(0, Math.floor(text.length / 2));
    const stopAt = failure?.kind === "interrupt" ? Math.min(failure.afterChars ?? 200, text.length - 1) : text.length;
    if (this.firstTokenMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.firstTokenMs);
        req.signal?.addEventListener("abort", () => (clearTimeout(t), reject(new ProviderError("cancelled", "Cancelled"))), { once: true });
      });
    }
    let sent = 0;
    // With a delay (development, `LEARN_PROVIDER=mock`), small chunks so live previews visibly grow.
    const size = this.chunkDelayMs ? 24 : 160;
    while (sent < stopAt) {
      if (req.signal?.aborted) throw new ProviderError("cancelled", "Cancelled");
      const chunk = text.slice(sent, Math.min(sent + size, stopAt));
      sent += chunk.length;
      req.onDelta?.(chunk);
      await new Promise((r) => (this.chunkDelayMs ? setTimeout(r, this.chunkDelayMs) : setImmediate(r)));
    }
    if (failure?.kind === "interrupt") throw new ProviderError("interrupted", "Mock stream interrupted", true);
    return { text };
  }
}

// ── Task responders ─────────────────────────────────────────────────────────

export function respond(task: string, input: any): unknown {
  switch (task) {
    case "analyze_source":
      return analyze(input);
    case "plan_objective":
      return plan(input);
    case "explain":
      return explain(input);
    case "question":
      return question(input);
    case "evaluate_reasoning":
      return evaluate(input);
    case "practice_outline":
      return practiceOutline(input);
    case "practice_problem":
      return practiceProblem(input);
    case "grade_practice":
      return gradePractice(input);
    case "practice_primer":
      return practicePrimer(input);
    case "practice_coach":
      return practiceCoach(input);
    case "practice_coach_check":
      return practiceCoachCheck(input);
    case "follow_up":
      return followUp(input);
    default:
      throw new ProviderError("unsupported", `mock has no responder for ${task}`);
  }
}

const isMarkov = (s: string) => /markov|second[- ]order|transition/i.test(s);
const nameOf = (slug: string) => CURRICULUM.find((c) => c.slug === slug)!.name;

function fixtureConcept(c: FixtureConcept, pages: number[]) {
  return {
    name: c.name,
    definition: c.definition,
    role: c.role,
    pages,
    prerequisites: c.prerequisites.map(nameOf),
  };
}

function analyze(input: { title: string; unit: string; pages: { page: number; text: string }[] }) {
  const pages = input.pages ?? [];
  const heading = (t: string) => t.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 150) ?? "Untitled";
  const structure = pages.map((p) => ({ title: heading(p.text), pageStart: p.page, pageEnd: p.page }));
  if (pages.some((p) => isMarkov(p.text))) {
    const concepts = CURRICULUM.map((c) =>
      fixtureConcept(
        c,
        pages.filter((p) => p.page > 1 && c.keywords.test(p.text)).map((p) => p.page),
      ),
    );
    return {
      kind: "lecture",
      title: heading(pages[0]?.text ?? input.title),
      overview:
        "This lecture builds sequence models from conditional probability. It motivates why the full history cannot be modelled (the chain rule's histories grow exponentially), introduces the Markov assumption, works through first-order chains with transition matrices, extends to second-order models whose state is a pair of previous symbols, and ends with estimating transition probabilities by counting.",
      contributions: [],
      methods: [],
      experiments: [],
      conclusions: [],
      structure,
      concepts,
      learningPath: CURRICULUM.map((c) => c.name),
      relationsToPrevious: ["Relies on conditional probability from earlier probability lectures."],
    };
  }
  // Generic: one concept per content page heading, chained in order.
  const content = pages.slice(1, 7);
  const concepts = (content.length ? content : pages).map((p, i, arr) => ({
    name: heading(p.text).replace(/^[\d.\s]+/, "").slice(0, 100) || `Topic ${i + 1}`,
    definition: (p.text.replace(/\s+/g, " ").split(/(?<=\.)\s/)[1] ?? p.text.replace(/\s+/g, " ")).slice(0, 300) || "See the source page.",
    role: "central" as const,
    pages: [p.page],
    prerequisites: i > 0 ? [heading(arr[i - 1].text).replace(/^[\d.\s]+/, "").slice(0, 100)] : [],
  }));
  const seen = new Set<string>();
  const unique = concepts.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  unique.forEach((c) => (c.prerequisites = c.prerequisites.filter((p) => seen.has(p) && p !== c.name)));
  return {
    kind: "lecture",
    title: heading(pages[0]?.text ?? input.title),
    overview: `Mock overview of “${input.title}”, built from page headings: ${unique.map((c) => c.name).join(", ")}.`,
    structure,
    concepts: unique,
    learningPath: unique.map((c) => c.name),
  };
}

function plan(input: { objective: string }) {
  if (isMarkov(input.objective)) {
    return {
      title: "Second-order Markov models",
      overview: "From probability and conditional probability, through the chain rule and the Markov assumption, to first- and second-order Markov models and how their probabilities are estimated.",
      concepts: CURRICULUM.map((c) => fixtureConcept(c, [])),
      learningPath: CURRICULUM.map((c) => c.name),
    };
  }
  const goal = input.objective.trim().slice(0, 100) || "The objective";
  return {
    title: goal,
    overview: `Mock plan for “${goal}”.`,
    concepts: [
      { name: `Foundations of ${goal}`, definition: `The ideas ${goal} is built on.`, role: "background", pages: [], prerequisites: [] },
      { name: goal, definition: `The learning objective: ${goal}.`, role: "central", pages: [], prerequisites: [`Foundations of ${goal}`] },
    ],
    learningPath: [`Foundations of ${goal}`, goal],
  };
}

function refsFor(fx: FixtureConcept | undefined, source: { pages: { page: number; text: string }[] } | null | undefined) {
  if (!fx || !source) return [];
  return source.pages
    .filter((p) => fx.keywords.test(p.text))
    .slice(0, 2)
    .map((p) => {
      const line = p.text.split("\n").find((l) => fx.keywords.test(l))?.trim();
      return { page: p.page, ...(line ? { quote: line.slice(0, 120) } : {}) };
    });
}

function explain(input: any) {
  const fx = findFixture(input.concept?.name ?? "");
  const avoid: string[] = input.avoidStrategies ?? [];
  const requested: string = input.strategy ?? "first_principles";
  const available = fx ? (Object.keys(fx.explanations) as (keyof FixtureConcept["explanations"])[]) : [];
  const chosen =
    (available.includes(requested as any) ? requested : undefined) ?? available.find((s) => !avoid.includes(s)) ?? available[0];
  const prefix =
    input.purpose === "remediate" && input.learner?.misconceptions?.length
      ? `**A different angle.** A tempting idea here is *${input.learner.misconceptions[0].label}*. Let's see exactly where it breaks.\n\n`
      : input.purpose === "detour"
        ? `**Why this detour:** ${input.detourReason ?? "it underpins what we were studying"}.\n\n`
        : input.purpose === "return"
          ? `**Back to ${input.concept.name}.** You've now got ${input.connectTo?.[0] ?? "the prerequisite"}, which is the piece this idea rests on.\n\n`
          : "";
  const connections = (input.connectTo ?? []).slice(0, 3).map((n: string) => `Builds on ${n}`);
  if (fx && chosen) {
    const e = fx.explanations[chosen as keyof typeof fx.explanations]!;
    return { ...e, body: prefix + e.body, strategy: chosen, connections: e.connections ?? connections, refs: refsFor(fx, input.source) };
  }
  const name = input.concept?.name ?? "this concept";
  return {
    title: name,
    strategy: requested,
    body: `${prefix}*(Mock provider: placeholder explanation, strategy ${requested}.)*\n\n**${name}.** ${input.concept?.definition ?? ""}`,
    connections,
    refs: [],
  };
}

const GENERIC_TEMPLATES = [
  (n: string) => `Which statement best captures what “${n}” means?`,
  (n: string) => `A classmate is unsure what “${n}” refers to. Which description would you give them?`,
  (n: string) => `In your own field, where would “${n}” most plausibly apply?`,
  (n: string) => `Which claim about “${n}” is accurate?`,
  (n: string) => `What problem is “${n}” primarily meant to address?`,
  (n: string) => `If you removed “${n}” from the topic, which consequence would follow?`,
];

function question(input: any) {
  const fx = findFixture(input.concept?.name ?? "");
  const avoid = new Set<string>((input.avoid ?? []).map((a: { scenario: string }) => a.scenario.toLowerCase()));
  if (fx) {
    // Among acceptable items, prefer the one closest to the requested difficulty.
    const want = Number(input.difficulty ?? 2);
    const unused = fx.questions
      .filter((q) => !avoid.has(q.scenario.toLowerCase()))
      .sort((a, b) => Math.abs(a.difficulty - want) - Math.abs(b.difficulty - want));
    const pick =
      unused.find((q) => q.kind === input.kind && q.context === input.context) ??
      unused.find((q) => q.context === input.context && (input.context === "novel" || q.kind === input.kind)) ??
      unused.find((q) => q.kind === input.kind) ??
      unused.find((q) => primaryDimension(q.kind) === primaryDimension(input.kind) && (input.context !== "novel" || q.context === "novel")) ??
      unused.find((q) => q.context === input.context) ??
      unused[0];
    if (pick) return { ...pick, multiSelect: pick.multiSelect ?? false, refs: [] };
  }
  const name = input.concept?.name ?? "this concept";
  const n = avoid.size;
  return {
    stem: GENERIC_TEMPLATES[n % GENERIC_TEMPLATES.length](name) + (n >= GENERIC_TEMPLATES.length ? ` (variant ${n})` : ""),
    kind: input.kind ?? "conceptual",
    context: input.context ?? "original",
    scenario: `generic-${slugify(name)}-${n}`,
    // Options kept to similar lengths so the generic item passes the same shape checks.
    options: [
      { value: "def", label: `It is the idea that ${(input.concept?.definition ?? name).replace(/\s+/g, " ").slice(0, 60)}` },
      { value: "opposite", label: `It is the reverse of the usual definition of ${name}`.slice(0, 90), misconception: "inverts the definition" },
      { value: "unrelated", label: `It is a neighbouring idea that is often confused with ${name}`.slice(0, 90), misconception: "confuses it with a neighbouring idea" },
    ],
    correct: "def",
    explanation: `*(Mock)* The first option restates the definition of ${name}.`,
    rubric: { keyIdeas: [`the definition of ${name}`], commonFlaws: [] },
    difficulty: Math.min(5, Math.max(1, input.difficulty ?? 2)),
    refs: [],
  };
}

function evaluate(input: { question: { stem: string }; note: string }) {
  const note = input.note ?? "";
  const fx = CURRICULUM.find((c) => c.questions.some((q) => q.stem === input.question?.stem));
  if (!fx) return { verdict: "partially_sound", summary: "*(Mock)* Reasoning noted.", issues: [] };
  if (fx.reasoning.flawed.test(note)) {
    return {
      verdict: "flawed",
      summary: `Your written reasoning relies on an idea that doesn't hold here: ${fx.reasoning.misconception.description}`,
      issues: [fx.reasoning.misconception.description],
      misconception: fx.reasoning.misconception,
    };
  }
  if (fx.reasoning.sound.test(note)) return { verdict: "sound", summary: "Your reasoning identifies the key idea correctly.", issues: [] };
  return { verdict: "partially_sound", summary: "Your reasoning is on topic but doesn't yet name the key idea.", issues: ["Key idea not stated explicitly"] };
}
