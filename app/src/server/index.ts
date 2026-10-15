// `npm start`: start the local server on 127.0.0.1 and open the browser.
import open from "open";
import { createApp } from "./app.ts";
import { createContext } from "./context.ts";

const args = new Set(process.argv.slice(2));
const port = Number(process.env.LEARN_PORT ?? 4317);
const mock = process.env.LEARN_PROVIDER === "mock";
const ctx = createContext({
  // Demo pacing for the mock provider; LEARN_MOCK_DELAY_MS (per small chunk) and LEARN_MOCK_LATENCY_MS
  // (before the first token) simulate a slower model, e.g. to measure how responsive the UI feels.
  mockDelayMs: mock ? Number(process.env.LEARN_MOCK_DELAY_MS ?? 15) : 0,
  mockLatencyMs: mock ? Number(process.env.LEARN_MOCK_LATENCY_MS ?? 0) : 0,
});
const app = createApp(ctx);

const server = app.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Learn is running at ${url}`);
  console.log(`Data: ${ctx.dataDir}${process.env.LEARN_PROVIDER === "mock" ? "  (mock provider: no AI usage)" : ""}`);
  if (ctx.interruptedJobsAtBoot) console.log(`Recovered: ${ctx.interruptedJobsAtBoot} interrupted generation(s) discarded; lessons are intact.`);
  if (ctx.interruptedPracticeAtBoot) console.log(`Recovered: ${ctx.interruptedPracticeAtBoot} practice extraction(s) stopped mid-way; retry them to continue.`);
  if (ctx.interruptedFollowUpsAtBoot) console.log(`Recovered: ${ctx.interruptedFollowUpsAtBoot} follow-up answer(s) stopped mid-way; they wait for a retry.`);
  if (!args.has("--no-open")) open(url).catch(() => undefined);
});

const shutdown = () => {
  server.close();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
