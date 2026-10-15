// Regression tests for bugs found in a live ChatGPT run on ICS 691G Lecture 10 and the
// Exam 2 study guide: hidden question data, split concepts, overclaimed provenance,
// image-heavy decks, lost provider errors, and doubled misconceptions.
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/server/ai/prompts.ts";
import { provenanceFor, validateRefs } from "../src/server/alignment/refs.ts";
import { sameIdea, upsertConcepts } from "../src/server/graph/concepts.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { mapChatGPTError, OpenAIProvider } from "../src/server/providers/openai-siwc.ts";
import { testEncryption } from "../src/server/providers/keychain.ts";
import { analysisPages, boilerplateLines, excerptPages, feedbackMessage, scenarioDataProblem, stripBoilerplate } from "../src/server/teaching/engine.ts";
import { detourTarget, misconceptionRelatedness, type ConceptFacts, type Snapshot } from "../src/server/teaching/planner.ts";
import { initialLessonState, type AnalysisConcept, type MasterySummary } from "../src/shared/schemas.ts";
import { MARKOV_LECTURE, makePdf, pendingQuestion, testContext, tmpDir } from "./helpers.ts";

const concept = (c: Partial<AnalysisConcept> & { name: string; definition: string }): AnalysisConcept => ({ role: "central", pages: [], prerequisites: [], ...c });

describe("questions are self-contained (live question 71fbcdbe)", () => {
  const live = {
    stem: "At this cell, the recurrence records 0. If a high-scoring matching block occurs farther ahead, what causal effect does choosing 0 have?",
    scenario: "A Smith–Waterman cell has diagonal, vertical, and horizontal candidate scores of −3, −1, and −4.",
    options: [
      { label: "It removes the prior negative contribution from the score of the later block." },
      { label: "It carries the prior −1 contribution into the score of the later block." },
      { label: "It carries the total −8 contribution into the score of the later block." },
      { label: "It changes the prior −1 contribution into a bonus for the later block." },
    ],
  };

  it("rejects a question whose data lives only in the hidden scenario", () => {
    expect(scenarioDataProblem(live)).toMatch(/3, 4/);
    // Fixed by moving the data into the stem.
    expect(scenarioDataProblem({ ...live, stem: `A Smith–Waterman cell has candidates −3, −1 and −4 and records 0. ${live.stem}` })).toBeNull();
  });

  it("is conservative: labels, number words, one stray number and identifiers pass", () => {
    const opts = [{ label: "It keeps two states of memory." }, { label: "It keeps one state of memory." }];
    expect(scenarioDataProblem({ stem: "Which describes the model?", scenario: "weather forecast with two-day memory", options: opts })).toBeNull();
    expect(scenarioDataProblem({ stem: "A chain has three states and two symbols. How many parameters…?", scenario: "3 states, 2 symbols", options: opts })).toBeNull();
    expect(scenarioDataProblem({ stem: "A coin is flipped repeatedly.", scenario: "coin flipped 10 times", options: opts })).toBeNull();
    expect(scenarioDataProblem({ stem: "Reads from chromosome 21 are aligned.", scenario: "chr21 reads, H3K4 marks", options: opts })).toBeNull();
    // Mostly shown: only one of four values missing.
    expect(scenarioDataProblem({ stem: "Match +2, mismatch −1, gap −2 align GATTACA.", scenario: "match 2 mismatch 1 gap 2 band 5", options: opts })).toBeNull();
  });

  it("asks the model to repair such a question before it is shown", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    ctx.mock.failNext({ task: "question", kind: "mutate", mutate: (q: any) => ({ ...q, scenario: "a table whose cells hold 37, 91 and 45" }) });
    await ctx.engine.advance(lesson.id);
    const q = ctx.repo.getQuestion(ctx.repo.getLesson(lesson.id)!.state.pendingQuestionId!)!;
    expect(q.scenario).not.toMatch(/37/);
    const failed = ctx.repo.jobsForLesson(lesson.id).filter((j) => j.task === "question" && j.status === "failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0].error)).toMatch(/scenario.*37, 91, 45/);
  });

  it("tells the model the stem must carry the data and the scenario is hidden", () => {
    const { instructions } = buildPrompt("question", {});
    expect(instructions).toMatch(/learner sees ONLY the stem and the options/);
    expect(instructions).toMatch(/"scenario" is a short hidden label/);
  });
});

describe("concept graph does not split on a descriptive sense (8 duplicates in the live run)", () => {
  const stringNull = concept({ name: "String and substring", definition: "A string is an ordered finite sequence of symbols. A substring is a contiguous block of symbols occupying consecutive positions within a string." });
  const stringSense = concept({ name: "String and substring", sense: "finite biological sequence", definition: "A string is an ordered finite sequence of symbols from an alphabet; a substring is a contiguous segment of that string." });
  const probNull = concept({ name: "Probability", definition: "Probability is a numerical measure from 0 to 1 assigned to an event, where larger values represent greater likelihood under a specified probabilistic model." });
  const probSense = concept({ name: "Probability", sense: "likelihood of an event", definition: "The probability $P(A)$ of an event $A$ is a number from $0$ to $1$ representing its likelihood. Impossible events have probability $0$, certain events have probability $1$, and the probabilities of all mutually exclusive outcomes in the sample space sum to $1$." });

  it("reuses the same-named concept whichever side carries the sense", () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const a = upsertConcepts(ctx.repo, { courseId: course.id, lectureId: null, concepts: [stringSense, probNull], learningPath: ["String and substring", "Probability"] });
    const b = upsertConcepts(ctx.repo, { courseId: course.id, lectureId: null, concepts: [stringNull, probSense], learningPath: ["String and substring", "Probability"] });
    expect(b.map((p) => p.conceptId)).toEqual(a.map((p) => p.conceptId));
    expect(ctx.repo.listConcepts()).toHaveLength(2);
  });

  it("keeps true homonyms apart, with or without a sense on both sides", () => {
    const ctx = testContext();
    const os = concept({ name: "Kernel", definition: "The kernel is the core program of an operating system that manages memory, processes and hardware access, running in privileged mode." });
    const ml = concept({ name: "Kernel", sense: "machine learning", definition: "A kernel is a function k(x, y) that computes an inner product between two inputs in an implicit feature space, enabling non-linear classifiers such as support vector machines." });
    const img = concept({ name: "Kernel", sense: "image processing", definition: "A kernel is a small matrix of weights convolved with an image to blur, sharpen or detect edges." });
    const ids = [os, ml, img].map((c) => upsertConcepts(ctx.repo, { courseId: null, lectureId: null, concepts: [c], learningPath: [c.name] })[0].conceptId);
    expect(new Set(ids).size).toBe(3);
    // A sense-less later mention of the ML kernel still finds the ML concept.
    const again = concept({ name: "Kernel", definition: "A kernel function computes an inner product between two inputs in an implicit feature space, which lets linear classifiers such as support vector machines become non-linear." });
    expect(upsertConcepts(ctx.repo, { courseId: null, lectureId: null, concepts: [again], learningPath: ["Kernel"] })[0].conceptId).toBe(ids[1]);
  });

  it("a sense-less mention merges with a sensed one; different-field senses don't", () => {
    const tbA = { definition: "Traceback is the reconstruction of an optimal solution by following stored predecessor choices backward through a completed dynamic-programming table." };
    const tbB = { sense: "sequence alignment", definition: "Traceback reconstructs an optimal solution by following predecessor choices backward from a terminal dynamic-programming cell to an initialization cell." };
    expect(sameIdea("Traceback", tbA, tbB)).toBe(true);
    const entropyInfo = { definition: "Entropy H(X) is the expected self-information of a random variable, measuring average uncertainty in bits." };
    const entropyThermo = { sense: "thermodynamics", definition: "Entropy is a state function measuring the number of microscopic configurations of a physical system, related to heat transfer divided by temperature." };
    expect(sameIdea("Entropy", entropyInfo, entropyThermo)).toBe(false);
  });

  it("tells the model to set sense only for genuine homonyms", () => {
    const { instructions } = buildPrompt("analyze_source", {});
    expect(instructions).toMatch(/Set it ONLY to disambiguate a genuine homonym/);
    expect(instructions).not.toMatch(/set "sense" when a common name is used in a domain-specific way/);
  });
});

describe("provenance needs a verified quote (live explanation d8477661 cited bare pages)", () => {
  it("page-only refs are kept but don't make content 'source'", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "l4.pdf" });
    const pageOnly = validateRefs(ctx.repo, r.source.id, [{ page: 2 }, { page: 5 }, { page: 9, quote: "not on this page at all, invented" }], "Lecture 4").refs;
    expect(pageOnly.map((x) => x.page)).toEqual([2, 5, 9]);
    expect(provenanceFor(pageOnly)).toBe("supplementary");
    const quoted = validateRefs(ctx.repo, r.source.id, [{ page: 9, quote: "Two symbols of memory." }], "Lecture 4").refs;
    expect(provenanceFor(quoted)).toBe("source");
    expect(provenanceFor([])).toBe("supplementary");
  });

  it("an explanation citing only page numbers is labelled supplementary, and so is the overview", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    await ctx.engine.advance(lesson.id); // overview + first probe
    const overview = ctx.repo.listBlocks(lesson.id).find((b) => b.type === "overview")!;
    expect(overview.refs.length).toBeGreaterThan(0);
    expect(overview.provenance).toBe("supplementary");
    const q = pendingQuestion(ctx, lesson.id)!;
    await ctx.engine.answer(lesson.id, q.id, { dontKnow: true });
    ctx.mock.failNext({ task: "explain", kind: "mutate", mutate: (e: any) => ({ ...e, refs: [{ page: 2 }, { page: 3 }] }) });
    await ctx.engine.advance(lesson.id);
    const ex = ctx.repo.listBlocks(lesson.id).find((b) => b.type === "explanation")!;
    expect(ex.refs.map((x) => x.page)).toEqual([2, 3]);
    expect(ex.provenance).toBe("supplementary");
  });

  it("asks for an exact quote with every ref", () => {
    expect(buildPrompt("explain", {}).instructions).toMatch(/give every ref a "quote"/);
    expect(buildPrompt("question", {}).instructions).toMatch(/each with a "quote"/);
  });
});

describe("image-heavy, annotated decks (22 of 78 Lec 10 pages were only a copyright banner)", () => {
  const BANNER = "(c) Lenore Pipes 2026 - This content is protected and may not be shared";
  const deck = [
    `${BANNER}\nLecture 10: Sequence alignment`,
    `${BANNER}\nEdit distance\nThe edit distance counts the insertions, deletions and substitutions that turn one string into another.`,
    BANNER,
    `${BANNER}\nGlobal alignment`,
    BANNER,
    BANNER,
    `${BANNER}\nNeedleman-Wunsch fills a matrix V[i][j] with the best score of aligning the prefixes x[1..i] and y[1..j].\nEach cell takes the maximum of three candidates: diagonal, up and left.`,
    `${BANNER}\nGap penalties\nA linear gap penalty charges the same cost for every gap symbol.`,
  ];

  it("finds lines repeated on most pages, and only those", () => {
    expect([...boilerplateLines(deck)]).toEqual([BANNER]);
    expect(boilerplateLines(deck.slice(0, 3)).size).toBe(0); // too few pages to judge
    expect(stripBoilerplate(deck[1], boilerplateLines(deck))).toMatch(/^Edit distance\nThe edit distance/);
  });

  it("analysis input drops the banner and marks pages without usable text", () => {
    const pages = analysisPages(deck);
    expect(pages.map((p) => p.text).join("\n")).not.toContain("Lenore Pipes");
    expect(pages[2].text).toBe("[page 3: no extractable text — figure or handwriting]");
    expect(pages[3].text).toMatch(/^\[page 4: only a short fragment is extractable.*\] Global alignment$/);
    expect(pages[6].text).toMatch(/^Needleman-Wunsch/);
    // The prompt tells the model what the markers mean.
    expect(buildPrompt("analyze_source", {}).instructions).toMatch(/Do not describe or guess what they show/);
  });

  it("excerpts skip empty pages and fill the budget from neighbouring pages", () => {
    // Mapped only to a title slide followed by figure-only slides: the content after them is used.
    expect(excerptPages(deck, [4], 3000).map((p) => p.page)).toEqual([7, 8]);
    // Mapped pages come first, in the analysis's order; the rest only while the budget lasts.
    const tight = excerptPages(deck, [7, 2], 300);
    expect(tight.map((p) => p.page)).toEqual([7]);
    expect(tight[0].text).not.toContain("Lenore");
    // Every usable page when they're short (the old code sent at most the first 2–3 mapped pages,
    // which here would have been the edit-distance page and two empty ones).
    expect(excerptPages(deck, [2, 3, 4, 5, 6, 7, 8], 4500).map((p) => p.page)).toEqual([1, 2, 7, 8]);
  });

  it("the engine sends the cleaned analysis and window excerpts to the model", async () => {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const pdf = await makePdf(deck.map((p) => p.split("\n")));
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: pdf, filename: "Lecture 10.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    const analyze = ctx.mock.calls.find((c) => c.task === "analyze_source")!;
    expect(JSON.stringify(analyze.input.pages)).not.toContain("Lenore Pipes");
    expect(analyze.input.pages[4].text).toBe("[page 5: no extractable text — figure or handwriting]");

    // Map the first concept to the title slide only.
    const rows = ctx.repo.lectureConcepts(r.lecture.id);
    const first = ctx.repo.getLesson(lesson.id)!.state.path[0];
    ctx.repo.setLectureConcepts(r.lecture.id, rows.map(({ lecture_id: _l, ...row }) => (row.concept_id === first ? { ...row, pages: [4] } : row)));
    await ctx.engine.advance(lesson.id);
    const explain = ctx.mock.calls.find((c) => c.task === "explain" || c.task === "question")!;
    expect(explain.input.source.pages.map((p: { page: number }) => p.page)).toEqual([7, 8]);
  });
});

describe("ChatGPT errors keep their cause", () => {
  // Shaped like the DevKit's ChatGPTError for a `response.failed` stream event with an unrecognised code.
  const devkitError = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("ChatGPT could not complete this request."), { name: "ChatGPTError", code, retryable: false, status: 200, requestId: "req_abc123", ...extra });

  it("preserves the DevKit code and marks transient failures retryable", () => {
    const e = mapChatGPTError(devkitError("server_error"));
    expect(e.code).toBe("unavailable");
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("ChatGPT could not complete this request. (server_error)");
    expect(e.detail).toMatchObject({ devkitCode: "server_error", status: 200, requestId: "req_abc123" });

    expect(mapChatGPTError(devkitError("rate_limit_exceeded", { status: 429 }))).toMatchObject({ code: "unavailable", retryable: true });
    expect(mapChatGPTError(devkitError("api_error", { status: 503 }))).toMatchObject({ code: "unavailable", retryable: true });
    expect(mapChatGPTError(devkitError("network_error", { status: undefined, retryable: true }))).toMatchObject({ code: "unavailable", retryable: true });
    expect(mapChatGPTError(devkitError("api_error", { status: 403 }))).toMatchObject({ code: "unavailable", retryable: false });
  });

  it("maps usage limits and auth failures, keeping the code", () => {
    const limit = mapChatGPTError(devkitError("subscription_sharing_usage_limit_exceeded"));
    expect(limit).toMatchObject({ code: "usage_limit", retryable: false });
    expect(limit.detail).toMatchObject({ devkitCode: "subscription_sharing_usage_limit_exceeded", usageUrl: expect.stringContaining("chatgpt.com") });
    expect(mapChatGPTError(devkitError("api_error", { status: 401 })).code).toBe("auth_required");
    expect(mapChatGPTError(devkitError("chatpass_v2_scope_not_authorized")).code).toBe("auth_required");
    expect(mapChatGPTError(devkitError("model_not_found")).code).toBe("unsupported");
    expect(mapChatGPTError({ code: "stream_interrupted", message: "cut", retryable: true })).toMatchObject({ code: "interrupted", retryable: true });
  });

  it("never passes credentials through", () => {
    const e = mapChatGPTError({ code: "weird code with spaces", message: "failed: Authorization: Bearer abc.def.ghi token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig and sk-abcdefghijklmnop" });
    expect(e.message).not.toMatch(/abc\.def|eyJ|sk-abcdef/);
    expect(e.detail).toMatchObject({ devkitCode: "unknown" });
  });

  it("retries a transient failure once when no text has arrived, and never after output or on a limit", async () => {
    const r = testContext().repo;
    r.setSetting("openai.model", "gpt-test");
    const script: (() => Promise<{ text: string }>)[] = [];
    let calls = 0;
    const client = {
      signIn: async () => ({ status: "connected", sharing: true }),
      cancelSignIn() {},
      getSession: async () => ({ status: "connected", sharing: true }),
      listModels: async () => [{ slug: "gpt-test", displayName: "GPT Test" }],
      disconnect: async () => {},
      streamResponse: async (o: any) => {
        calls++;
        const step = script.shift();
        if (step) return step.call(o);
        o.onDelta?.("ok");
        return { text: "ok" };
      },
    };
    const p = new OpenAIProvider({ repo: r, storageDir: tmpDir(), devkitDir: "/x", encryption: testEncryption(), retryDelayMs: 0, loadDevkit: async () => ({ createChatGPT: () => client as any }) });
    const req = { task: "t", instructions: "", messages: [{ role: "user" as const, content: "x" }] };

    script.push(async () => Promise.reject(devkitError("server_error")));
    expect((await p.stream(req)).text).toBe("ok");
    expect(calls).toBe(2);

    calls = 0;
    script.push(async function (this: any) {
      this.onDelta?.("partial");
      throw devkitError("server_error");
    });
    await expect(p.stream(req)).rejects.toMatchObject({ code: "unavailable", retryable: true });
    expect(calls).toBe(1);

    calls = 0;
    script.push(async () => Promise.reject(devkitError("subscription_sharing_usage_limit_exceeded")));
    await expect(p.stream(req)).rejects.toMatchObject({ code: "usage_limit" });
    expect(calls).toBe(1);

    calls = 0;
    script.push(async () => Promise.reject(devkitError("server_error")), async () => Promise.reject(devkitError("server_error")));
    await expect(p.stream(req)).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("server_error") });
    expect(calls).toBe(2);
  });
});

describe("feedback and misconceptions", () => {
  it("doesn't double the period after a sentence-shaped misconception", () => {
    const m = feedbackMessage(false, "sure", null, "Assumes global alignment is suitable when only one sequence is complete.");
    expect(m).toContain("*Assumes global alignment is suitable when only one sequence is complete*.");
    expect(m).not.toMatch(/\.\*\./);
  });

  async function wrongAnswerSetup() {
    const ctx = testContext();
    const course = ctx.repo.createCourse("C");
    const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4.pdf" });
    const lesson = await ctx.engine.startLectureLesson(r.lecture.id);
    await ctx.engine.advance(lesson.id);
    const q = ctx.repo.getQuestion(ctx.repo.getLesson(lesson.id)!.state.pendingQuestionId!)!;
    const distractor = q.options.find((o) => o.misconception)!;
    const flawed = { verdict: "flawed", summary: "The reasoning confuses the two.", issues: [], misconception: { label: "reasoning-level confusion", description: "what the written reasoning shows" } };
    return { ctx, lessonId: lesson.id, q, distractor, flawed };
  }

  it("a wrong answer with diagnosed reasoning records one misconception: the reasoning's", async () => {
    const { ctx, lessonId, q, distractor, flawed } = await wrongAnswerSetup();
    ctx.mock.failNext({ task: "evaluate_reasoning", kind: "mutate", mutate: () => flawed });
    const { feedback } = await ctx.engine.answer(lessonId, q.id, { selected: [distractor.value], confidence: "sure", note: "because it seemed right" });
    expect(ctx.repo.activeMisconceptions(q.concept_id).map((m) => m.label)).toEqual(["reasoning-level confusion"]);
    expect(feedback.payload.misconceptions).toEqual(["reasoning-level confusion"]);
    // The hint still describes the option that was chosen.
    expect(feedback.payload.message).toContain(distractor.misconception!.replace(/[.!?]+$/, ""));
  });

  it("without a reasoning diagnosis, the distractor's misconception is recorded", async () => {
    const { ctx, lessonId, q, distractor } = await wrongAnswerSetup();
    await ctx.engine.answer(lessonId, q.id, { selected: [distractor.value], confidence: "sure" });
    expect(ctx.repo.activeMisconceptions(q.concept_id).map((m) => m.label)).toEqual([distractor.misconception]);
  });

  it("reasoning evaluated later replaces the distractor's misconception for that attempt", async () => {
    const { ctx, lessonId, q, distractor, flawed } = await wrongAnswerSetup();
    ctx.mock.failNext({ task: "evaluate_reasoning", kind: "interrupt", afterChars: 5 });
    await ctx.engine.answer(lessonId, q.id, { selected: [distractor.value], confidence: "sure", note: "because it seemed right" });
    expect(ctx.repo.activeMisconceptions(q.concept_id).map((m) => m.label)).toEqual([distractor.misconception]);
    ctx.mock.failNext({ task: "evaluate_reasoning", kind: "mutate", mutate: () => flawed });
    expect(await ctx.engine.processPendingReasoning()).toBe(1);
    expect(ctx.repo.activeMisconceptions(q.concept_id).map((m) => m.label)).toEqual(["reasoning-level confusion"]);
    const fb = ctx.repo.listBlocks(lessonId).find((b) => b.type === "feedback")!;
    expect(fb.payload.misconceptions).toEqual(["reasoning-level confusion"]);
  });
});

describe("remediation detours follow the misconception", () => {
  const mastery = (status: MasterySummary["status"]): MasterySummary => ({ conceptId: "", status, dimensions: {} as MasterySummary["dimensions"], reasons: [], lastEvidenceAt: null });
  const facts = (f: Partial<ConceptFacts> & { id: string; name: string }): ConceptFacts => ({
    role: "background",
    mastery: mastery("not_assessed"),
    activeMisconceptions: [],
    prerequisites: [],
    history: [],
    failedStrategies: [],
    hasStoredReviewQuestion: false,
    ...f,
  });
  const scoring = facts({ id: "score", name: "Alignment scoring function", definition: "A scoring function assigns match, mismatch and gap scores to alignment columns and sums them.", mastery: mastery("developing") });
  const dp = facts({ id: "dp", name: "Dynamic programming", definition: "Dynamic programming stores the optimal values of overlapping subproblems and combines them with a recurrence." });
  const snap = (cur: ConceptFacts): Snapshot => {
    const all = new Map([cur, scoring, dp].map((x) => [x.id, x]));
    return { state: initialLessonState([cur.id], null), hasSource: false, facts: (id) => all.get(id)! };
  };

  it("prefers the prerequisite the misconception is about, then falls back to rank", () => {
    const global = facts({ id: "global", name: "Global alignment", prerequisites: ["dp", "score"], activeMisconceptions: ["Free terminal gaps"], misconceptionText: "Free terminal gaps Thinks gaps at the ends of an alignment cost nothing, so mismatched ends can be dropped from the score." });
    expect(misconceptionRelatedness(global, scoring)).toBeGreaterThan(misconceptionRelatedness(global, dp));
    expect(detourTarget(snap(global), global)).toBe("score");
    // No misconception text: rank decides (never-assessed before developing).
    const plain = facts({ id: "global", name: "Global alignment", prerequisites: ["score", "dp"] });
    expect(detourTarget(snap(plain), plain)).toBe("dp");
  });
});
