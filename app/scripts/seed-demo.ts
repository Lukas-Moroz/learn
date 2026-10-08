// Creates a demo course with a generated "Lecture 4: Markov Chains" PDF, so the app can
// be tried immediately (pair with LEARN_PROVIDER=mock for zero AI usage).
import { createContext } from "../src/server/context.ts";
import { importFile } from "../src/server/ingest/import.ts";
import { MARKOV_LECTURE, makePdf } from "../test/helpers.ts";

const ctx = createContext();
const existing = ctx.repo.listCourses().find((c) => c.title === "Probabilistic Models (demo)");
const course = existing ?? ctx.repo.createCourse("Probabilistic Models (demo)");
const r = await importFile(ctx.repo, ctx.dataDir, { courseId: course.id, data: await makePdf(MARKOV_LECTURE), filename: "Lecture 4 - Markov Chains.pdf" });
console.log(`Demo course ready in ${ctx.dataDir} (${r.status}).`);
ctx.db.close();
