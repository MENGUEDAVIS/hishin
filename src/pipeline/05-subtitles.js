import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { subtitlesDir, transcriptsDir } from '../media/paths.js';
import { buildSubtitleCues, clampMs, msToSrtTimestamp, msToVttTimestamp } from '../media/timeline.js';

/**
 * 05-subtitles: projects word timestamps from source takes onto the
 * timeline actually produced by 04-assemble, then emits SRT/VTT. Every
 * timestamp here is derived arithmetic on ffprobe/Transcribe timing,
 * never a language-model estimate.
 */

const SubtitlesInputSchema = z.object({
  project_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  manifest_path: z.string().min(1),
});

/**
 * @typedef {object} SubtitlesOutput
 * @property {string} srt_path
 * @property {string} vtt_path
 * @property {number} cue_count
 */

/** @param {import('../media/timeline.js').SubtitleCue[]} cues @returns {string} */
function formatSrt(cues) {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${msToSrtTimestamp(cue.startMs)} --> ${msToSrtTimestamp(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n');
}

/** @param {import('../media/timeline.js').SubtitleCue[]} cues @returns {string} */
function formatVtt(cues) {
  const body = cues
    .map((cue) => `${msToVttTimestamp(cue.startMs)} --> ${msToVttTimestamp(cue.endMs)}\n${cue.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/**
 * @param {unknown} input
 * @returns {Promise<SubtitlesOutput>}
 */
export async function generateSubtitles(input) {
  const { project_id: projectId, manifest_path: manifestPath } = SubtitlesInputSchema.parse(input);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  /** @type {import('../media/timeline.js').Word[]} */
  const outputWords = [];
  /** @type {Map<string, any>} */
  const transcriptCache = new Map();

  for (const entry of manifest.timeline) {
    if (entry.kind === 'photo') {
      // A held photo with no narration has no spoken words to caption —
      // its optional caption is already burned into the video itself.
      continue;
    }

    if (entry.kind === 'narration') {
      // Polly speech marks are already local to this segment (0-based), so
      // the output offset is simply where the segment starts.
      for (const word of entry.words) {
        outputWords.push({
          text: word.text,
          startMs: clampMs(word.startMs + entry.output_start_ms, entry.output_start_ms, entry.output_end_ms),
          endMs: clampMs(word.endMs + entry.output_start_ms, entry.output_start_ms, entry.output_end_ms),
        });
      }
      continue;
    }

    // kind === 'take' (or absent, for manifests written before `kind` existed)
    const takeId = basename(entry.source_file, extname(entry.source_file));
    let transcript = transcriptCache.get(takeId);
    if (!transcript) {
      transcript = JSON.parse(await readFile(join(transcriptsDir(projectId), `${takeId}.json`), 'utf8'));
      transcriptCache.set(takeId, transcript);
    }

    const offsetMs = entry.output_start_ms - entry.source_start_ms;
    for (const word of transcript.words) {
      if (word.startMs >= entry.source_end_ms || word.endMs <= entry.source_start_ms) continue;
      outputWords.push({
        text: word.text,
        startMs: clampMs(word.startMs + offsetMs, entry.output_start_ms, entry.output_end_ms),
        endMs: clampMs(word.endMs + offsetMs, entry.output_start_ms, entry.output_end_ms),
      });
    }
  }

  const cues = buildSubtitleCues(outputWords);

  const srtPath = join(subtitlesDir(projectId), `${manifest.renderId}.srt`);
  const vttPath = join(subtitlesDir(projectId), `${manifest.renderId}.vtt`);
  await writeFile(srtPath, formatSrt(cues));
  await writeFile(vttPath, formatVtt(cues));

  return { srt_path: srtPath, vtt_path: vttPath, cue_count: cues.length };
}
