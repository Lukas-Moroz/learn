// Checkpoints are assembled deterministically from recorded evidence, never from
// model output, so a failed or partial generation can never produce a checkpoint.
import type { LessonRow } from "../db/repo.ts";
import { calibrationSummary } from "../../shared/mastery.ts";
import type { LessonState } from "../../shared/schemas.ts";
import type { Engine } from "./engine.ts";

export interface CheckpointPayload {
  index: number;
  concepts: { conceptId: string; name: string; status: string; reasons: string[] }[];
  learned: { name: string; definition: string }[];
  canExplain: string[];
  uncertain: { name: string; why: string }[];
  misconceptions: { concept: string; label: string; status: string }[];
  connections: string[];
  next: { name: string; where: string | null } | null;
  calibration: ReturnType<typeof calibrationSummary>;
}

export function buildCheckpoint(engine: Engine, lesson: LessonRow, state: LessonState): CheckpointPayload {
  const repo = engine.repo;
  const blocks = repo.listBlocks(lesson.id);
  const lastCp = [...blocks].reverse().find((b) => b.type === "checkpoint");
  const since = blocks.filter((b) => !lastCp || b.seq > lastCp.seq);
  const detourConcepts = since.filter((b) => b.type === "detour_start").map((b) => b.conceptId!);
  const ids = [...new Set([...detourConcepts, ...state.sinceCheckpoint])];

  const concepts = ids.map((id) => {
    const m = engine.mastery(id, state.roles[id] ?? "background");
    return { conceptId: id, name: repo.getConcept(id)!.name, status: state.deferred.includes(id) && m.status !== "demonstrated" ? "deferred" : m.status, reasons: m.reasons, dims: m.dimensions };
  });

  const learned = concepts.filter((c) => c.status === "demonstrated").map((c) => ({ name: c.name, definition: repo.getConcept(c.conceptId)!.definition }));
  const canExplain = concepts.filter((c) => c.dims.explanation === "positive" || (c.dims.recognition === "positive" && c.dims.transfer === "positive")).map((c) => c.name);
  const uncertain = concepts
    .filter((c) => c.status !== "demonstrated" || Object.values(c.dims).includes("weak"))
    .map((c) => ({ name: c.name, why: c.status !== "demonstrated" ? c.reasons[0] ?? "Not yet demonstrated" : "Some answers were correct but not confident" }));

  const misconceptions = ids.flatMap((id) =>
    repo
      .misconceptions(id)
      .filter((m) => !lastCp || m.last_seen >= lastCp.createdAt || m.status !== "resolved")
      .map((m) => ({ concept: repo.getConcept(id)!.name, label: m.label, status: m.status === "resolved" ? "resolved" : m.status })),
  );

  const connections: string[] = [];
  for (const id of ids) {
    for (const p of repo.prerequisitesOf(id)) {
      connections.push(`${repo.getConcept(id)!.name} builds on ${repo.getConcept(p)!.name}`);
    }
  }

  const nextId = state.detours.length ? state.detours[state.detours.length - 1].fromConceptId : state.path[state.pathIndex];
  const next = nextId
    ? { name: repo.getConcept(nextId)!.name, where: engine.positionLabel(lesson, engine.conceptPages(lesson, nextId)[0] ?? state.sourcePosition?.page ?? null) }
    : null;

  const attempts = since
    .filter((b) => b.type === "feedback")
    .map((b) => ({ correct: b.payload.correct as boolean | null, confidence: b.payload.confidence }));

  return {
    index: state.checkpointCount + 1,
    concepts: concepts.map(({ dims: _d, ...c }) => c),
    learned,
    canExplain,
    uncertain,
    misconceptions,
    connections: [...new Set(connections)].slice(0, 8),
    next,
    calibration: calibrationSummary(attempts),
  };
}
