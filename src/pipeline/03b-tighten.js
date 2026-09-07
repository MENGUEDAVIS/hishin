import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { rawDir, tightenDir, transcriptsDir } from '../media/paths.js';
import { detectSilence } from '../media/probe.js';
import { subtractIntervals, sumDurationMs } from '../media/timeline.js';

/**
 * 03b-tighten: removes dead air using ffmpeg-measured silence, with a
 * conservative margin so cuts never land inside a word. All boundaries
 * come from signal analysis and transcript timing, never from an agent.
 */

const TightenInputSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  takeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  marginMs: z.number().int().min(0).max(2000).optional(),
  minSilenceToCutMs: z.number().int().min(0).optional(),
});

/**
 * @typedef {object} TightFragment
 * @property {string} fragmentId
 * @property {number} startMs
 * @property {number} endMs
 * @property {string[]} includesSentenceIds
 */

/**
 * @typedef {object} TightenOutput
 * @property {string} projectId
 * @property {string} takeId
 * @property {number} originalDurationMs
 * @property {number} tightDurationMs
 * @property {number} removedMs
 * @property {TightFragment[]} fragments
 */

/**
 * @param {string} projectId
 * @param {string} takeId
 * @returns {Promise<{ storedPath: string, durationMs: number }>}
 */
async function loadTakeInfo(projectId, takeId) {
  const manifest = JSON.parse(await readFile(join(rawDir(projectId), 'manifest.json'), 'utf8'));
  const take = manifest.takes.find((/** @type {{ takeId: string }} */ t) => t.takeId === takeId);
  if (!take) throw new Error(`Unknown takeId (not found in ingest manifest): ${takeId}`);
  return { storedPath: take.storedPath, durationMs: take.durationMs };
}

/**
 * @param {unknown} input
 * @returns {Promise<TightenOutput>}
 */
export async function tighten(input) {
  const { projectId, takeId, marginMs = 120, minSilenceToCutMs = 500 } = TightenInputSchema.parse(input);

  const { storedPath, durationMs: originalDurationMs } = await loadTakeInfo(projectId, takeId);
  const transcript = JSON.parse(await readFile(join(transcriptsDir(projectId), `${takeId}.json`), 'utf8'));

  const silences = await detectSilence(storedPath);
  const cuttableSilences = silences
    .filter((s) => s.endMs - s.startMs >= minSilenceToCutMs)
    .map((s) => ({ startMs: s.startMs + marginMs, endMs: s.endMs - marginMs }))
    .filter((s) => s.endMs > s.startMs);

  const keepIntervals = subtractIntervals({ startMs: 0, endMs: originalDurationMs }, cuttableSilences);

  /** @type {TightFragment[]} */
  const fragments = keepIntervals.map((interval, index) => {
    const includesSentenceIds = transcript.sentences
      .filter(
        (/** @type {{ startMs: number, endMs: number, sentenceId: string }} */ sentence) =>
          sentence.startMs < interval.endMs && sentence.endMs > interval.startMs,
      )
      .map((/** @type {{ sentenceId: string }} */ sentence) => sentence.sentenceId);
    return {
      fragmentId: `${takeId}_f${String(index + 1).padStart(2, '0')}`,
      startMs: interval.startMs,
      endMs: interval.endMs,
      includesSentenceIds,
    };
  });

  const tightDurationMs = sumDurationMs(fragments);
  const record = {
    projectId,
    takeId,
    marginMs,
    minSilenceToCutMs,
    originalDurationMs,
    tightDurationMs,
    removedMs: originalDurationMs - tightDurationMs,
    silences,
    fragments,
  };
  await writeFile(join(tightenDir(projectId), `${takeId}.json`), JSON.stringify(record, null, 2));

  return {
    projectId,
    takeId,
    originalDurationMs,
    tightDurationMs,
    removedMs: originalDurationMs - tightDurationMs,
    fragments,
  };
}
