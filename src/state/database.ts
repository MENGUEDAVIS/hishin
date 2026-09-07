import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stateDbFile } from '../media/paths.js';

/**
 * One SQLite file per project (data/projects/<id>/state.sqlite), per the
 * architecture decision to use Node 24's native node:sqlite rather than an
 * extra dependency. Connections are cached for the process lifetime.
 */
const openConnections = new Map<string, DatabaseSync>();

export async function openProjectDb(projectId: string): Promise<DatabaseSync> {
  const existing = openConnections.get(projectId);
  if (existing) return existing;

  const file = stateDbFile(projectId);
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      round INTEGER NOT NULL,
      verdict TEXT,
      output_path TEXT,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      created_at TEXT NOT NULL
    )
  `);
  openConnections.set(projectId, db);
  return db;
}
