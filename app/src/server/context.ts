// Wires the application together. Tests build a context with an in-memory DB and
// the mock provider; the real app uses ~/.learn and the subscription providers.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Generator } from "./ai/generate.ts";
import { openDatabase, type DB } from "./db/database.ts";
import { Repo } from "./db/repo.ts";
import { EventBus } from "./events.ts";
import { ClaudeCliProvider } from "./providers/claude-cli.ts";
import { keychainEncryption, type CredentialEncryption } from "./providers/keychain.ts";
import { MockProvider } from "./providers/mock/index.ts";
import { OpenAIProvider } from "./providers/openai-siwc.ts";
import { FollowUpService } from "./followup/service.ts";
import { PracticeService } from "./practice/service.ts";
import { ProviderRouter } from "./providers/router.ts";
import type { ProviderId } from "./providers/types.ts";
import { Engine } from "./teaching/engine.ts";

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface AppContext {
  dataDir: string;
  db: DB;
  repo: Repo;
  bus: EventBus;
  router: ProviderRouter;
  gen: Generator;
  engine: Engine;
  practice: PracticeService;
  followUps: FollowUpService;
  mock: MockProvider;
  openai: OpenAIProvider;
  claude: ClaudeCliProvider;
  interruptedJobsAtBoot: number;
  /** Practice extractions cut off by the last shutdown (marked failed; retry resumes them). */
  interruptedPracticeAtBoot: number;
  /** Follow-up answers cut off by the last shutdown (waiting; retried on request or resume). */
  interruptedFollowUpsAtBoot: number;
}

export interface ContextOptions {
  dataDir?: string;
  /** ":memory:" for tests. */
  dbFile?: string;
  forceProvider?: ProviderId | null;
  mockDelayMs?: number;
  /** Mock provider: wait before the first token (ms). */
  mockLatencyMs?: number;
  /** Minimum time between live preview events for one generation (ms; default 250). */
  previewMs?: number;
  encryption?: CredentialEncryption;
  claudeBin?: string;
  /** Where the Sign in with ChatGPT DevKit was built (tests point this at a missing dir). */
  siwcDir?: string;
  now?: () => Date;
}

export function defaultDataDir() {
  return process.env.LEARN_DATA_DIR ?? join(homedir(), ".learn");
}

export function createContext(o: ContextOptions = {}): AppContext {
  const dataDir = o.dataDir ?? defaultDataDir();
  const db = openDatabase(o.dbFile ?? join(dataDir, "learn.db"));
  const repo = new Repo(db);
  // Anything still "running" belonged to a process that died. Its partial output is never used.
  const interruptedJobsAtBoot = repo.markInterruptedJobs();
  const bus = new EventBus();
  const mock = new MockProvider(o.mockDelayMs ?? 0, o.mockLatencyMs ?? 0);
  const openai = new OpenAIProvider({
    repo,
    storageDir: join(dataDir, "secrets", "chatgpt"),
    devkitDir: o.siwcDir ?? process.env.LEARN_SIWC_DIR ?? join(APP_DIR, "vendor", "siwc-devkit"),
    encryption: o.encryption ?? keychainEncryption(),
  });
  const claude = new ClaudeCliProvider({ repo, bin: o.claudeBin });
  const forced = o.forceProvider !== undefined ? o.forceProvider : process.env.LEARN_PROVIDER === "mock" ? "mock" : null;
  const router = new ProviderRouter(repo, { openai, claude, mock }, forced);
  const gen = new Generator(repo, router, bus, { previewMs: o.previewMs });
  const engine = new Engine(repo, gen, bus, o.now);
  const practice = new PracticeService(repo, gen, bus, engine);
  const interruptedPracticeAtBoot = practice.recoverAtBoot();
  const followUps = new FollowUpService(repo, practice, engine, gen, bus);
  const interruptedFollowUpsAtBoot = followUps.recoverAtBoot();
  return { dataDir, db, repo, bus, router, gen, engine, practice, followUps, mock, openai, claude, interruptedJobsAtBoot, interruptedPracticeAtBoot, interruptedFollowUpsAtBoot };
}
