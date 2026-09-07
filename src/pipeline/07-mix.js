import { stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { runFfmpeg } from '../media/ffmpeg.js';
import { probeMedia } from '../media/probe.js';

/**
 * 07-mix: final audio mix (voice + optional music with sidechain ducking),
 * loudness normalization, optional soft-subtitle muxing, and final render.
 * Every number here — duration, loudness — comes from ffmpeg/ffprobe
 * measurement, never from a model.
 */

const MixInputSchema = z.object({
  project_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  video_path: z.string().min(1),
  music: z
    .object({
      stored_path: z.string().min(1),
      volume_db: z.number().optional(),
    })
    .optional(),
  subtitles_path: z.string().min(1).optional(),
  target_lufs: z.number().optional(),
  ducking: z
    .object({
      threshold: z.number().positive().max(1).optional(),
      ratio: z.number().positive().optional(),
      attack_ms: z.number().positive().optional(),
      release_ms: z.number().positive().optional(),
    })
    .optional(),
  output_format: z.enum(['mp4', 'mov']).default('mp4'),
});

/**
 * @typedef {object} LoudnessMeasured
 * @property {number} integrated_lufs
 * @property {number} true_peak_dbtp
 * @property {number} loudness_range
 */

/**
 * @typedef {object} MixOutput
 * @property {string} output_path
 * @property {number} duration_ms
 * @property {LoudnessMeasured | null} loudness_measured
 * @property {string[]} warnings
 */

/**
 * Runs ffmpeg's loudnorm filter in analysis mode and parses its JSON report.
 * @param {string} filePath
 * @returns {Promise<LoudnessMeasured | null>}
 */
async function measureLoudness(filePath) {
  const { stderr } = await runFfmpeg([
    '-i',
    filePath,
    '-af',
    'loudnorm=print_format=json',
    '-f',
    'null',
    '-',
  ]);
  const match = stderr.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const report = JSON.parse(match[0]);
  return {
    integrated_lufs: Number(report.input_i),
    true_peak_dbtp: Number(report.input_tp),
    loudness_range: Number(report.input_lra),
  };
}

/**
 * @param {unknown} input
 * @returns {Promise<MixOutput>}
 */
export async function mix(input) {
  const parsed = MixInputSchema.parse(input);
  const targetLufs = parsed.target_lufs ?? -14;
  const musicVolumeDb = parsed.music?.volume_db ?? -18;
  const duck = {
    threshold: parsed.ducking?.threshold ?? 0.05,
    ratio: parsed.ducking?.ratio ?? 8,
    attackMs: parsed.ducking?.attack_ms ?? 5,
    releaseMs: parsed.ducking?.release_ms ?? 300,
  };

  const videoInfo = await stat(parsed.video_path).catch(() => null);
  if (!videoInfo || !videoInfo.isFile()) {
    throw new Error(`video_path not found: ${parsed.video_path}`);
  }

  /** @type {string[]} */
  const warnings = [];
  const videoDurationSec = (await probeMedia(parsed.video_path)).durationMs / 1000;
  const outputPath = join(dirname(parsed.video_path), `final.${parsed.output_format}`);

  // ffmpeg requires every -i to appear before any per-output option (-af,
  // -filter_complex, -map, -c:*). Interleaving them (e.g. -af right before a
  // later -i for subtitles) makes ffmpeg misparse the option as belonging to
  // that next input and fail — so inputs and output options are built as
  // separate arrays and only concatenated at the very end.
  /** @type {string[]} */
  const inputArgs = ['-y', '-i', parsed.video_path];
  if (parsed.music) {
    inputArgs.push('-stream_loop', '-1', '-i', parsed.music.stored_path);
  }
  if (parsed.subtitles_path) {
    inputArgs.push('-i', parsed.subtitles_path);
  }

  /** @type {string[]} */
  const outputArgs = [];
  /** @type {string[]} */
  const mapArgs = [];
  /** @type {string[]} */
  const codecArgs = ['-c:v', 'copy'];

  if (parsed.music) {
    const filter = [
      '[0:a]asplit=2[voice_main][voice_sc]',
      `[1:a]atrim=0:${videoDurationSec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${musicVolumeDb}dB[music_pre]`,
      `[music_pre][voice_sc]sidechaincompress=threshold=${duck.threshold}:ratio=${duck.ratio}:attack=${duck.attackMs}:release=${duck.releaseMs}[music_duck]`,
      `[voice_main][music_duck]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=${targetLufs}:TP=-1.5:LRA=11[aout]`,
    ].join(';');
    outputArgs.push('-filter_complex', filter);
    mapArgs.push('-map', '0:v', '-map', '[aout]');
  } else {
    outputArgs.push('-af', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`);
    mapArgs.push('-map', '0:v', '-map', '0:a');
  }

  if (parsed.subtitles_path) {
    const subInputIndex = parsed.music ? 2 : 1;
    mapArgs.push('-map', `${subInputIndex}:s`);
    codecArgs.push('-c:s', 'mov_text');
  }

  codecArgs.push('-c:a', 'aac', '-ar', '48000', '-ac', '2');

  await runFfmpeg([...inputArgs, ...outputArgs, ...mapArgs, ...codecArgs, outputPath]);

  const finalProbe = await probeMedia(outputPath);
  const loudnessMeasured = await measureLoudness(outputPath).catch((error) => {
    warnings.push(`Loudness measurement failed: ${/** @type {Error} */ (error).message}`);
    return null;
  });

  const manifest = {
    videoPath: parsed.video_path,
    outputPath,
    durationMs: finalProbe.durationMs,
    loudnessMeasured,
    warnings,
    renderedAt: new Date().toISOString(),
  };
  await writeFile(join(dirname(outputPath), 'mix-manifest.json'), JSON.stringify(manifest, null, 2));

  return {
    output_path: outputPath,
    duration_ms: finalProbe.durationMs,
    loudness_measured: loudnessMeasured,
    warnings,
  };
}
