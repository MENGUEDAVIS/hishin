import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appDbFile } from '../media/paths.js';

/**
 * Multi-user support is intentionally kept out of the pipeline/agents/tools
 * layers entirely — they still only know about a projectId, exactly as
 * before. This is the one place that maps a projectId to the Cognito user
 * (`sub`) who created it, so the server can scope and authorize access.
 * A single global database (not one per project) since ownership spans
 * every project.
 */

let db: DatabaseSync | undefined;

async function open(): Promise<DatabaseSync> {
  if (db) return db;
  const file = appDbFile();
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_owners (
      project_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export interface AuthUser {
  id: string;
  email?: string;
}

/** Records/refreshes a user's profile on each authenticated request. Cheap upsert. */
export async function touchUser(user: AuthUser): Promise<void> {
  const conn = await open();
  const now = new Date().toISOString();
  conn
    .prepare(
      `INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, last_seen_at = excluded.last_seen_at`,
    )
    .run(user.id, user.email ?? null, now, now);
}

/** Records ownership the first time a projectId is created. Idempotent — later calls are no-ops. */
export async function recordProjectOwnerIfAbsent(projectId: string, ownerId: string): Promise<void> {
  const conn = await open();
  conn
    .prepare('INSERT OR IGNORE INTO project_owners (project_id, owner_id, created_at) VALUES (?, ?, ?)')
    .run(projectId, ownerId, new Date().toISOString());
}

/** Returns the owner of a project, or undefined if the project has no recorded owner (pre-auth data). */
export async function getProjectOwner(projectId: string): Promise<string | undefined> {
  const conn = await open();
  const row = conn.prepare('SELECT owner_id FROM project_owners WHERE project_id = ?').get(projectId) as
    | { owner_id: string }
    | undefined;
  return row?.owner_id;
}

/** All projectIds owned by a given user. */
export async function listProjectIdsForOwner(ownerId: string): Promise<string[]> {
  const conn = await open();
  const rows = conn.prepare('SELECT project_id FROM project_owners WHERE owner_id = ?').all(ownerId) as {
    project_id: string;
  }[];
  return rows.map((r) => r.project_id);
}
