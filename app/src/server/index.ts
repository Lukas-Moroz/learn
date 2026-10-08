// `npm start`: start the local server on 127.0.0.1 and open the browser.
import open from "open";
import { createApp } from "./app.ts";
import { createContext } from "./context.ts";

const args = new Set(process.argv.slice(2));
const port = Number(process.env.LEARN_PORT ?? 4317);
const ctx = createContext({ mockDelayMs: process.env.LEARN_PROVIDER === "mock" ? 15 : 0 });
const app = createApp(ctx);

const server = app.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Learn is running at ${url}`);
  console.log(`Data: ${ctx.dataDir}${process.env.LEARN_PROVIDER === "mock" ? "  (mock provider: no AI usage)" : ""}`);
  if (ctx.interruptedJobsAtBoot) console.log(`Recovered: ${ctx.interruptedJobsAtBoot} interrupted generation(s) discarded; lessons are intact.`);
  if (!args.has("--no-open")) open(url).catch(() => undefined);
});

const shutdown = () => {
  server.close();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
