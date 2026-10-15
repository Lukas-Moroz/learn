// Creates a demo course with a generated "Lecture 4: Markov Chains" PDF, so the app can
// be tried immediately (pair with LEARN_PROVIDER=mock for zero AI usage). It also adds a
// lecture on alignment and information and a demo exam-practice set (study guide plus
// solutions), extracted with the deterministic mock fixtures: seeding never uses AI.
import { createContext } from "../src/server/context.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { ALIGNMENT_LECTURE, MARKOV_LECTURE, PRACTICE_GUIDE, PRACTICE_SOLUTIONS, makePdf } from "../test/helpers.ts";

const ctx = createContext({ forceProvider: "mock" });
const existing = ctx.repo.listCourses().find((c) => c.title === "Probabilistic Models (demo)");
const course = existing ?? ctx.repo.createCourse("Probabilistic Models (demo)");
const add = async (pages: string[][], filename: string) => importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(pages), filename });
const r = await add(MARKOV_LECTURE, "Lecture 4 - Markov Chains.pdf");
await add(ALIGNMENT_LECTURE, "Lecture 5 - Alignment and Information.pdf");
const guide = await add(PRACTICE_GUIDE, "Practice Exam (demo).pdf");
const solutions = await add(PRACTICE_SOLUTIONS, "Practice Exam (demo) Solutions.pdf");
const set = ctx.practice.create(course.id, { problemSourceId: guide.source.id, solutionSourceId: solutions.source.id });
await ctx.practice.extraction(set.id);
const practice = ctx.practice.getSet(set.id);
console.log(`Demo course ready in ${ctx.dataDir} (${r.status}); practice set "${practice.title}": ${practice.status}, ${practice.progress.done} problems.`);
ctx.db.close();
