import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { derushDir, ensureProjectDirs, rawDir, transcriptsDir } from '../media/paths.js';
import { detectSilence } from '../media/probe.js';

/**
 * 03-derush: flags likely failed or duplicate takes with explainable,
 * deterministic heuristics. Nothing is deleted here — the Director decides
 * editorial relevance from these flags.
 */

const DerushInputSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  takeIds: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)).min(1),
});

export const FILLER_WORDS = new Set(['euh', 'heu', 'hum', 'bah', 'ben', 'uh', 'um', 'euhh']);
const RESTART_PATTERN = /^(on\s+refait|je\s+recommence|encore\s+une\s+fois|retake|reprise|on\s+reprend)/i;
const FILLER_RATIO_THRESHOLD = 0.15;
const TAIL_SILENCE_RATIO_THRESHOLD = 0.25;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

/**
 * @typedef {object} DerushFlag
 * @property {string} takeId
 * @property {string} [sentenceId]
 * @property {string} flagType
 * @property {number} score
 * @property {string} explanation
 */

/**
 * @typedef {object} DuplicateMember
 * @property {string} takeId
 * @property {string} sentenceId
 * @property {string} text
 */

/**
 * @typedef {object} DuplicateGroup
 * @property {string} groupId
 * @property {DuplicateMember[]} members
 * @property {number} similarity
 */

/** @param {string} text @returns {string} */
export function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} a @param {string} b @returns {number} */
function jaccardSimilarity(a, b) {
  const setA = new Set(normalizeText(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * @param {string} projectId
 * @param {string} takeId
 * @returns {Promise<{ words: import('../media/timeline.js').Word[], sentences: import('../media/timeline.js').Sentence[] }>}
 */
async function loadTranscript(projectId, takeId) {
  const raw = await readFile(join(transcriptsDir(projectId), `${takeId}.json`), 'utf8');
  return JSON.parse(raw);
}

/**
 * @param {string} projectId
 * @param {string} takeId
 * @returns {Promise<string>}
 */
async function loadStoredPath(projectId, takeId) {
  const manifest = JSON.parse(await readFile(join(rawDir(projectId), 'manifest.json'), 'utf8'));
  const take = manifest.takes.find((/** @type {{ takeId: string }} */ t) => t.takeId === takeId);
  if (!take) throw new Error(`Unknown takeId (not found in ingest manifest): ${takeId}`);
  return take.storedPath;
}

/**
 * @param {unknown} input
 * @returns {Promise<{ projectId: string, flags: DerushFlag[], duplicateGroups: DuplicateGroup[] }>}
 */
export async function derush(input) {
  const { projectId, takeIds } = DerushInputSchema.parse(input);

  /** @type {DerushFlag[]} */
  const flags = [];
  /** @type {Map<string, { words: any[], sentences: any[] }>} */
  const transcripts = new Map();

  for (const takeId of takeIds) {
    const transcript = await loadTranscript(projectId, takeId);
    transcripts.set(takeId, transcript);

    if (transcript.words.length > 0) {
      const fillerCount = transcript.words.filter((/** @type {{ text: string }} */ w) =>
        FILLER_WORDS.has(normalizeText(w.text)),
      ).length;
      const ratio = fillerCount / transcript.words.length;
      if (ratio >= FILLER_RATIO_THRESHOLD) {
        flags.push({
          takeId,
          flagType: 'filler_heavy',
          score: Number(ratio.toFixed(3)),
          explanation: `${fillerCount}/${transcript.words.length} words are fillers (${(ratio * 100).toFixed(0)}%)`,
        });
      }
    }

    for (const sentence of transcript.sentences) {
      if (RESTART_PATTERN.test(sentence.text.trim())) {
        flags.push({
          takeId,
          sentenceId: sentence.sentenceId,
          flagType: 'explicit_restart',
          score: 1,
          explanation: `Sentence explicitly signals a restart: "${sentence.text}"`,
        });
      }
    }

    try {
      const storedPath = await loadStoredPath(projectId, takeId);
      const silences = await detectSilence(storedPath);
      const lastWordEnd = transcript.words.at(-1)?.endMs ?? 0;
      const trailing = silences.find((s) => s.startMs >= lastWordEnd - 200);
      const takeDurationMs = trailing ? trailing.endMs : lastWordEnd;
      if (trailing && takeDurationMs > 0) {
        const tailRatio = (trailing.endMs - trailing.startMs) / takeDurationMs;
        if (tailRatio >= TAIL_SILENCE_RATIO_THRESHOLD) {
          flags.push({
            takeId,
            flagType: 'dead_air_tail',
            score: Number(tailRatio.toFixed(3)),
            explanation: `Trailing silence of ${trailing.endMs - trailing.startMs}ms after last spoken word`,
          });
        }
      }
    } catch (error) {
      flags.push({
        takeId,
        flagType: 'silence_analysis_failed',
        score: 0,
        explanation: /** @type {Error} */ (error).message,
      });
    }
  }

  /** @type {DuplicateGroup[]} */
  const duplicateGroups = [];
  /** @type {DuplicateMember[]} */
  const allSentences = [];
  for (const [takeId, transcript] of transcripts) {
    for (const sentence of transcript.sentences) {
      allSentences.push({ takeId, sentenceId: sentence.sentenceId, text: sentence.text });
    }
  }

  const consumed = new Set();
  let groupIndex = 0;
  for (let i = 0; i < allSentences.length; i += 1) {
    if (consumed.has(i)) continue;
    const anchor = allSentences[i];
    if (!anchor) continue;
    /** @type {DuplicateMember[]} */
    const members = [anchor];
    let maxSimilarity = 0;
    for (let j = i + 1; j < allSentences.length; j += 1) {
      if (consumed.has(j)) continue;
      const candidate = allSentences[j];
      if (!candidate) continue;
      const similarity = jaccardSimilarity(anchor.text, candidate.text);
      if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
        members.push(candidate);
        consumed.add(j);
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }
    }
    if (members.length > 1) {
      groupIndex += 1;
      consumed.add(i);
      duplicateGroups.push({
        groupId: `dup_${String(groupIndex).padStart(2, '0')}`,
        members,
        similarity: Number(maxSimilarity.toFixed(3)),
      });
    }
  }

  await ensureProjectDirs(projectId);
  await writeFile(
    join(derushDir(projectId), 'report.json'),
    JSON.stringify({ projectId, flags, duplicateGroups, computedAt: new Date().toISOString() }, null, 2),
  );

  return { projectId, flags, duplicateGroups };
}
