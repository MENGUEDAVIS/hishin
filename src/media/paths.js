import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Identifiers are used as path segments; only a conservative slug is safe. */
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/**
 * @param {string} id
 * @param {string} label
 * @returns {string}
 */
export function assertSafeId(id, label) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(id)}`);
  }
  return id;
}

/** @returns {string} */
export function dataDir() {
  return process.env.DATA_DIR || './data';
}

/**
 * Global (not per-project) database: user profiles and project ownership.
 * @returns {string}
 */
export function appDbFile() {
  return join(dataDir(), 'app.sqlite');
}

/** @param {string} projectId @returns {string} */
export function projectDir(projectId) {
  assertSafeId(projectId, 'projectId');
  return join(dataDir(), 'projects', projectId);
}

/** @param {string} projectId @returns {string} */
export function projectFile(projectId) {
  return join(projectDir(projectId), 'project.json');
}

/** @param {string} projectId @returns {string} */
export function rawDir(projectId) {
  return join(projectDir(projectId), 'raw');
}

/** @param {string} projectId @returns {string} */
export function transcriptsDir(projectId) {
  return join(projectDir(projectId), 'transcripts');
}

/** @param {string} projectId @returns {string} */
export function derushDir(projectId) {
  return join(projectDir(projectId), 'derush');
}

/** @param {string} projectId @returns {string} */
export function tightenDir(projectId) {
  return join(projectDir(projectId), 'tighten');
}

/** @param {string} projectId @returns {string} */
export function plansDir(projectId) {
  return join(projectDir(projectId), 'plans');
}

/** @param {string} projectId @returns {string} */
export function rendersDir(projectId) {
  return join(projectDir(projectId), 'renders');
}

/** @param {string} projectId @returns {string} */
export function subtitlesDir(projectId) {
  return join(projectDir(projectId), 'subtitles');
}

/** @param {string} projectId @returns {string} */
export function projectSoundsDir(projectId) {
  return join(projectDir(projectId), 'sounds');
}

/** @param {string} projectId @returns {string} */
export function photosDir(projectId) {
  return join(projectDir(projectId), 'photos');
}

/** @param {string} projectId @returns {string} */
export function narrationDir(projectId) {
  return join(projectDir(projectId), 'narration');
}

/** @returns {string} */
export function soundLibraryDir() {
  return join(dataDir(), 'sounds');
}

/** @param {string} projectId @returns {string} */
export function tracesFile(projectId) {
  return join(projectDir(projectId), 'traces', 'events.jsonl');
}

/** @param {string} projectId @returns {string} */
export function stateDbFile(projectId) {
  return join(projectDir(projectId), 'state.sqlite');
}

/**
 * Ensures every standard subdirectory of a project exists.
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export async function ensureProjectDirs(projectId) {
  const dirs = [
    rawDir(projectId),
    transcriptsDir(projectId),
    derushDir(projectId),
    tightenDir(projectId),
    plansDir(projectId),
    rendersDir(projectId),
    subtitlesDir(projectId),
    projectSoundsDir(projectId),
    photosDir(projectId),
    narrationDir(projectId),
    join(projectDir(projectId), 'traces'),
    soundLibraryDir(),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}
