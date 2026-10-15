// Disposable regression server. All fixtures use an in-memory database and demo generation.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createContext } from '../../app/src/server/context.ts';
import { createApp } from '../../app/src/server/app.ts';
import { importFile } from '../../app/src/server/ingest/import.ts';
import { ALIGNMENT_LECTURE, MARKOV_LECTURE, PRACTICE_GUIDE, PRACTICE_SOLUTIONS, makePdf } from '../../app/test/helpers.ts';

const dataDir = process.env.LEARN_FLOW_DATA || '/private/tmp/learn-flow-audit-isolated';
mkdirSync(dataDir, { recursive: true });
const pdfs = await Promise.all([MARKOV_LECTURE, ALIGNMENT_LECTURE, PRACTICE_GUIDE, PRACTICE_SOLUTIONS].map(makePdf));
let ctx: ReturnType<typeof createContext>;
let app: ReturnType<typeof createApp>;
let fixture: { setId: string; problemIds: string[]; lectureId: string };

async function reset() {
  if (ctx) {
    ctx.engine.prefetch.cancelAll();
    await ctx.engine.prefetch.idle();
    await ctx.practice.idle();
    ctx.db.close();
  }
  ctx = createContext({ dataDir, dbFile: ':memory:', forceProvider: 'mock', mockDelayMs: 2, claudeBin: '/nonexistent/claude', siwcDir: '/nonexistent/siwc' });
  const course = ctx.repo.createCourse('UI flow examples');
  const add = (index: number, filename: string) => importFile(ctx.repo, dataDir, { courseId: course.id, data: pdfs[index], filename });
  const lecture = await add(0, 'Lecture 4 - Markov Chains.pdf');
  await add(1, 'Lecture 5 - Alignment.pdf');
  const guide = await add(2, 'Exam 2 Study Guide.pdf');
  const solutions = await add(3, 'Exam 2 Study Guide Solutions.pdf');
  const set = ctx.practice.create(course.id, { problemSourceId: guide.source.id, solutionSourceId: solutions.source.id });
  await ctx.practice.extraction(set.id);
  fixture = { setId: set.id, problemIds: ctx.practice.getSet(set.id).problems.map((p) => p.id), lectureId: lecture.lecture.id };
  app = createApp(ctx);
  return fixture;
}

function seedReview() {
  const concepts = ctx.repo.listConcepts().slice(0, 2);
  for (const concept of concepts) {
    ctx.repo.insertQuestion({
      lesson_id: null, block_id: null, concept_id: concept.id, purpose: 'review', kind: 'conceptual', context: 'original',
      scenario: `audit-${concept.id}`, stem: `Which statement best describes ${concept.name}?`,
      options: [
        { value: 'right', label: concept.definition },
        { value: 'wrong', label: 'The idea has no connection to probability or information.', misconception: `misreads ${concept.name}` },
      ], correct: ['right'], multi_select: false, explanation: concept.definition,
      rubric: { keyIdeas: [concept.definition], commonFlaws: [] }, difficulty: 1,
    });
    ctx.repo.addEvidence(concept.id, null, null, [{ dimension: 'recognition', delta: -1, at: new Date().toISOString() }]);
    ctx.repo.recordMisconception(concept.id, `misreads ${concept.name}`, null, 'sure');
  }
  return { ok: true };
}

async function seedLesson(detour = false) {
  // Foreground generation keeps this fixture independent of background prefetch timing.
  ctx.repo.setSetting('generation', { prefetch: false });
  const lesson = await ctx.engine.startLectureLesson(fixture.lectureId);
  await ctx.engine.advance(lesson.id); // analyzes the source and creates its concepts before selecting a detour target
  let originalConceptId: string | undefined;
  if (detour) {
    originalConceptId = ctx.repo.listConcepts().find((c) => c.name === 'Second-order Markov model')!.id;
    await ctx.engine.skipConcept(lesson.id, ctx.repo.getLesson(lesson.id)!.state.conceptId!);
    const current = ctx.repo.getLesson(lesson.id)!;
    ctx.repo.saveLessonState(lesson.id, { ...current.state, pathIndex: current.state.path.indexOf(originalConceptId), conceptId: originalConceptId, pendingQuestionId: null, sourcePosition: { sourceId: current.source_id!, page: 9 } }, current.version);
    for (let i = 0; i < 2; i++) {
      await ctx.engine.advance(lesson.id);
      const q = ctx.repo.getQuestion(ctx.repo.getLesson(lesson.id)!.state.pendingQuestionId!)!;
      await ctx.engine.answer(lesson.id, q.id, { selected: [q.options.find((o) => !q.correct.includes(o.value))!.value], confidence: 'sure' });
    }
    await ctx.engine.advance(lesson.id);
  }
  const q = ctx.repo.getQuestion(ctx.repo.getLesson(lesson.id)!.state.pendingQuestionId!)!;
  return { lessonId: lesson.id, conceptId: q.concept_id, questionId: q.id, wrongIndex: q.options.findIndex((o) => !q.correct.includes(o.value)), originalConceptId };
}

await reset();
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/__audit/')) {
    if (req.method !== 'POST' || req.headers['x-learn'] !== '1') return void res.writeHead(403).end();
    try {
      let result: unknown;
      switch (req.url) {
        case '/__audit/reset': result = await reset(); break;
        case '/__audit/review': result = seedReview(); break;
        case '/__audit/lesson': result = await seedLesson(); break;
        case '/__audit/detour': result = await seedLesson(true); break;
        case '/__audit/idle': await ctx.practice.idle(); result = { ok: true }; break;
        case '/__audit/pause-coaching': ctx.mock.failNext({ task: 'practice_coach', kind: 'usage_limit' }); result = { ok: true }; break;
        default: return void res.writeHead(404).end();
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  app(req, res);
});
server.listen(4330, '127.0.0.1', () => console.log('Disposable flow regression server: http://127.0.0.1:4330'));
function stop() { ctx.engine.prefetch.cancelAll(); server.close(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
