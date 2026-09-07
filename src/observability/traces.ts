import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tracesFile } from '../media/paths.js';

/**
 * Appends one JSON line per event to data/projects/<id>/traces/events.jsonl.
 * Deliberately dumb (append-only, no querying) — good enough to diagnose an
 * interrupted run, per docs/architecture.md's observability plan.
 */
export async function appendTrace(projectId: string, event: Record<string, unknown>): Promise<void> {
  const file = tracesFile(projectId);
  await mkdir(dirname(file), { recursive: true });
  const line = JSON.stringify({ ...event, projectId, ts: new Date().toISOString() });
  await appendFile(file, `${line}\n`);
}
