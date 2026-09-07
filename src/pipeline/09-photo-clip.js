import { z } from 'zod';
import { escapeDrawtextValue, runFfmpeg } from '../media/ffmpeg.js';
import { probeMedia } from '../media/probe.js';

/**
 * 09-photo-clip: turns a still image into a normalized video clip of an
 * exact, caller-specified duration — a slow zoom (Ken Burns) so a photo
 * doesn't look frozen, plus an optional burned-in caption. Used both for
 * plain photo segments and as the visual behind a narration segment.
 * Silent by design (a matching silent audio track is added so every clip
 * concat'd in 04-assemble.js has the same stream layout); any spoken
 * narration or music is layered in separately.
 */

const RenderPhotoClipInputSchema = z.object({
  photoPath: z.string().min(1),
  durationMs: z.number().positive(),
  outputPath: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  caption: z.string().min(1).max(200).optional(),
  kenBurns: z.boolean().default(true),
});

/**
 * @param {unknown} input
 * @returns {Promise<{ outputPath: string, durationMs: number }>}
 */
export async function renderPhotoClip(input) {
  const parsed = RenderPhotoClipInputSchema.parse(input);
  const durationSec = (parsed.durationMs / 1000).toFixed(3);
  const totalFrames = Math.max(1, Math.round((parsed.durationMs / 1000) * parsed.fps));

  const filters = [];
  if (parsed.kenBurns) {
    const coverWidth = Math.round(parsed.width * 1.15);
    const coverHeight = Math.round(parsed.height * 1.15);
    filters.push(`scale=${coverWidth}:${coverHeight}:force_original_aspect_ratio=increase`);
    filters.push(`crop=${coverWidth}:${coverHeight}`);
    filters.push(
      `zoompan=z='min(zoom+0.0015,1.15)':d=${totalFrames}:s=${parsed.width}x${parsed.height}:fps=${parsed.fps}`,
    );
  } else {
    filters.push(
      `scale=${parsed.width}:${parsed.height}:force_original_aspect_ratio=decrease,pad=${parsed.width}:${parsed.height}:(ow-iw)/2:(oh-ih)/2`,
    );
  }
  filters.push('setsar=1');
  if (parsed.caption) {
    const text = escapeDrawtextValue(parsed.caption);
    filters.push(
      `drawtext=text='${text}':fontcolor=white:fontsize=${Math.round(parsed.height / 24)}:box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=h-th-${Math.round(parsed.height / 16)}`,
    );
  }

  await runFfmpeg([
    '-y',
    '-loop',
    '1',
    '-i',
    parsed.photoPath,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-t',
    durationSec,
    '-vf',
    filters.join(','),
    '-r',
    String(parsed.fps),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    parsed.outputPath,
  ]);

  const probed = await probeMedia(parsed.outputPath);
  return { outputPath: parsed.outputPath, durationMs: probed.durationMs };
}

const RenderBackgroundClipInputSchema = z.object({
  durationMs: z.number().positive(),
  outputPath: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  color: z.string().min(1).default('#101114'),
  caption: z.string().min(1).max(200).optional(),
});

/**
 * A plain color clip with a matching silent audio track — the fallback
 * visual for a narration segment that has no photo_id, so it stays a
 * uniform, concat-compatible clip like every other segment.
 * @param {unknown} input
 * @returns {Promise<{ outputPath: string, durationMs: number }>}
 */
export async function renderBackgroundClip(input) {
  const parsed = RenderBackgroundClipInputSchema.parse(input);
  const durationSec = (parsed.durationMs / 1000).toFixed(3);

  const filters = ['setsar=1'];
  if (parsed.caption) {
    const text = escapeDrawtextValue(parsed.caption);
    filters.unshift(
      `drawtext=text='${text}':fontcolor=white:fontsize=${Math.round(parsed.height / 18)}:x=(w-text_w)/2:y=(h-text_h)/2`,
    );
  }

  await runFfmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${parsed.color}:s=${parsed.width}x${parsed.height}:r=${parsed.fps}:d=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-t',
    durationSec,
    '-vf',
    filters.join(','),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    parsed.outputPath,
  ]);

  const probed = await probeMedia(parsed.outputPath);
  return { outputPath: parsed.outputPath, durationMs: probed.durationMs };
}
