import { copyFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { ensureProjectDirs, projectSoundsDir, soundLibraryDir } from '../media/paths.js';
import { probeMedia } from '../media/probe.js';

/**
 * 06-sound-library: prepares music/SFX from the local, explicitly curated
 * library only. There is no arbitrary internet fetch here — an agent
 * cannot make this module pull from an attacker- or model-chosen URL, and
 * every asset carries the license text the caller supplies (never assumed
 * royalty-free).
 */

const FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,127}$/;

const RequestSchema = z.object({
  cue_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  type: z.enum(['music', 'sfx']),
  filename: z.string().regex(FILENAME).refine((f) => !f.includes('..'), 'path traversal not allowed'),
  license: z.string().min(1),
});

const SoundLibraryInputSchema = z.object({
  project_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  requests: z.array(RequestSchema).min(1),
});

/**
 * @typedef {object} PreparedAsset
 * @property {string} cue_id
 * @property {'music' | 'sfx'} type
 * @property {string} stored_path
 * @property {number} duration_ms
 * @property {string} license
 */

/**
 * @typedef {object} SoundLibraryOutput
 * @property {string} project_id
 * @property {PreparedAsset[]} assets
 * @property {string[]} warnings
 */

/**
 * @param {unknown} input
 * @returns {Promise<SoundLibraryOutput>}
 */
export async function prepareSoundLibrary(input) {
  const { project_id: projectId, requests } = SoundLibraryInputSchema.parse(input);
  await ensureProjectDirs(projectId);

  /** @type {string[]} */
  const warnings = [];
  /** @type {PreparedAsset[]} */
  const assets = [];

  for (const request of requests) {
    const sourcePath = join(soundLibraryDir(), request.filename);
    const info = await stat(sourcePath).catch(() => null);
    if (!info || !info.isFile()) {
      throw new Error(
        `Sound asset not found in local library: ${request.filename}. Only files already placed under ${soundLibraryDir()} are allowed — no remote fetching.`,
      );
    }

    const metadata = await probeMedia(sourcePath);
    if (!metadata.hasAudio) {
      warnings.push(`${request.filename}: no audio stream detected`);
    }

    const destPath = join(projectSoundsDir(projectId), `${request.cue_id}${extname(request.filename)}`);
    await copyFile(sourcePath, destPath);

    assets.push({
      cue_id: request.cue_id,
      type: request.type,
      stored_path: destPath,
      duration_ms: metadata.durationMs,
      license: request.license,
    });
  }

  const manifest = { projectId, assets, warnings, preparedAt: new Date().toISOString() };
  await writeFile(join(projectSoundsDir(projectId), 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { project_id: projectId, assets, warnings };
}
