import { openProjectDb } from './database.js';

export interface RunRecord {
  role: 'director' | 'critic';
  round: number;
  verdict?: string;
  outputPath?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export async function recordRun(projectId: string, record: RunRecord): Promise<void> {
  const db = await openProjectDb(projectId);
  const stmt = db.prepare(`
    INSERT INTO agent_runs
      (project_id, role, round, verdict, output_path, duration_ms, input_tokens, output_tokens, cost_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    projectId,
    record.role,
    record.round,
    record.verdict ?? null,
    record.outputPath ?? null,
    record.durationMs ?? null,
    record.inputTokens ?? null,
    record.outputTokens ?? null,
    record.costUsd ?? null,
    new Date().toISOString(),
  );
}

export async function listRuns(projectId: string): Promise<unknown[]> {
  const db = await openProjectDb(projectId);
  return db.prepare('SELECT * FROM agent_runs WHERE project_id = ? ORDER BY id ASC').all(projectId);
}
