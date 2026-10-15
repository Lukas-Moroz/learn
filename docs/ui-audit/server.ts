// Disposable test server. Never uses ~/.learn or a real generation provider.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { createContext } from '../../app/src/server/context.ts';
import { createApp } from '../../app/src/server/app.ts';
import { importFile } from '../../app/src/server/ingest/import.ts';
import { makePdf, MARKOV_LECTURE } from '../../app/test/helpers.ts';

const dataDir = process.env.LEARN_AUDIT_DATA || '/private/tmp/learn-ui-audit-isolated';
mkdirSync(dataDir, { recursive: true });
const pdf = await makePdf(MARKOV_LECTURE);
let ctx: ReturnType<typeof createContext>;
let app: ReturnType<typeof createApp>;
async function reset() {
  ctx?.db.close();
  ctx = createContext({ dataDir, dbFile: ':memory:', forceProvider: 'mock', mockDelayMs: 15 });
  const course = ctx.repo.createCourse('Probabilistic Models (demo)');
  await importFile(ctx.repo, dataDir, { courseId: course.id, data: pdf, filename: 'Lecture 4 - Markov Chains.pdf' });
  app = createApp(ctx);
}
await reset();
const server = createServer(async (req, res) => {
  if (req.url === '/__audit/reset') {
    if (req.method !== 'POST' || req.headers['x-learn'] !== '1') {
      res.writeHead(403).end();
      return;
    }
    try {
      await reset();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
    return;
  }
  app(req, res);
});
server.listen(4329, '127.0.0.1', () => console.log('Disposable UI audit server: http://127.0.0.1:4329'));
function stop() { server.close(); ctx.db.close(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
