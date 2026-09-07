import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { assertSafeId, ensureProjectDirs, rawDir } from '../media/paths.js';
import { probeMedia } from '../media/probe.js';

/**
 * 01-ingest: validates raw source files, copies them into project storage
 * under a stable take_id, and records deterministic ffprobe metadata.
 * Never touches timestamps beyond what ffprobe reports.
 */

const SourceSchema = z.object({
  path: z.string().min(1),
  takeId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
    .optional(),
});

const IngestInputSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  sources: z.array(SourceSchema).min(1),
});

/**
 * @typedef {object} IngestedTake
 * @property {string} takeId
 * @property {string} sourcePath
 * @property {string} storedPath
 * @property {string} sha256
 * @property {number} durationMs
 * @property {import('../media/probe.js').MediaMetadata} mediaMetadata
 */

/**
 * @typedef {object} IngestOutput
 * @property {string} projectId
 * @property {IngestedTake[]} takes
 * @property {string[]} warnings
 */

/** @param {string} filePath @returns {Promise<string>} */
async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * @param {number} index
 * @returns {string}
 */
function defaultTakeId(index) {
  return `take_${String(index + 1).padStart(2, '0')}`;
}

/**
 * @param {unknown} input
 * @returns {Promise<IngestOutput>}
 */
export async function ingest(input) {
  const { projectId, sources } = IngestInputSchema.parse(input);
  await ensureProjectDirs(projectId);

  /** @type {string[]} */
  const warnings = [];
  /** @type {IngestedTake[]} */
  const takes = [];
  const usedIds = new Set();

  for (const [index, source] of sources.entries()) {
    const takeId = assertSafeId(source.takeId ?? defaultTakeId(index), 'takeId');
    if (usedIds.has(takeId)) {
      throw new Error(`Duplicate takeId in ingest request: ${takeId}`);
    }
    usedIds.add(takeId);

    const info = await stat(source.path).catch(() => null);
    if (!info || !info.isFile()) {
      throw new Error(`Source file not found: ${source.path}`);
    }

    const storedPath = join(rawDir(projectId), `${takeId}${extname(source.path)}`);
    await copyFile(source.path, storedPath);

    const [sha256, mediaMetadata] = await Promise.all([
      sha256File(storedPath),
      probeMedia(storedPath),
    ]);

    if (!mediaMetadata.hasVideo && !mediaMetadata.hasAudio) {
      warnings.push(`${takeId}: no audio or video stream detected`);
    }

    takes.push({
      takeId,
      sourcePath: source.path,
      storedPath,
      sha256,
      durationMs: mediaMetadata.durationMs,
      mediaMetadata,
    });
  }

  const manifest = { projectId, takes, warnings, ingestedAt: new Date().toISOString() };
  await writeFile(join(rawDir(projectId), 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { projectId, takes, warnings };
}
