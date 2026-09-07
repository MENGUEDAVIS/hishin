import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runFfmpeg } from '../src/media/ffmpeg.js';

/**
 * Generates small synthetic audio/video fixtures with ffmpeg lavfi sources
 * (testsrc + sine/anullsrc), so pipeline tests exercise real ffmpeg/ffprobe
 * behavior without shipping binary media in the repository.
 */

/**
 * @typedef {object} FixtureSegment
 * @property {'silence' | 'tone'} type
 * @property {number} durationSec
 * @property {number} [freq]
 */

/**
 * @param {FixtureSegment[]} segments
 * @returns {{ type: 'silence' | 'tone', startMs: number, endMs: number }[]}
 */
export function segmentBoundariesMs(segments) {
  let cursorMs = 0;
  return segments.map((seg) => {
    const startMs = cursorMs;
    const endMs = cursorMs + Math.round(seg.durationSec * 1000);
    cursorMs = endMs;
    return { type: seg.type, startMs, endMs };
  });
}

/**
 * Renders a synthetic clip: silent gaps and audible tones concatenated,
 * with a plain testsrc video track of matching total duration.
 * @param {string} outputPath
 * @param {FixtureSegment[]} segments
 * @param {{ sampleRate?: number, width?: number, height?: number, fps?: number }} [opts]
 * @returns {Promise<{ outputPath: string, totalDurationSec: number }>}
 */
export async function generateFixtureMedia(outputPath, segments, opts = {}) {
  const sampleRate = opts.sampleRate ?? 16000;
  const width = opts.width ?? 640;
  const height = opts.height ?? 360;
  const fps = opts.fps ?? 25;
  const totalDurationSec = segments.reduce((sum, s) => sum + s.durationSec, 0);

  await mkdir(dirname(outputPath), { recursive: true });

  /** @type {string[]} */
  const args = ['-y'];
  for (const seg of segments) {
    if (seg.type === 'silence') {
      args.push('-f', 'lavfi', '-i', `anullsrc=r=${sampleRate}:cl=mono:d=${seg.durationSec}`);
    } else {
      args.push(
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${seg.freq ?? 440}:sample_rate=${sampleRate}:d=${seg.durationSec}`,
      );
    }
  }
  args.push('-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=${fps}:d=${totalDurationSec}`);

  const videoInputIndex = segments.length;
  const concatInputs = segments.map((_, i) => `[${i}:a]`).join('');
  const filter = `${concatInputs}concat=n=${segments.length}:v=0:a=1[aout]`;

  args.push(
    '-filter_complex',
    filter,
    '-map',
    `${videoInputIndex}:v`,
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'pcm_s16le',
    '-shortest',
    outputPath,
  );

  await runFfmpeg(args, { timeoutMs: 60_000 });
  return { outputPath, totalDurationSec };
}
