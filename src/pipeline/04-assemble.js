import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runFfmpeg } from '../media/ffmpeg.js';
import { narrationDir, photosDir, rawDir, rendersDir, tightenDir, transcriptsDir } from '../media/paths.js';
import { probeMedia } from '../media/probe.js';
import { renderBackgroundClip, renderPhotoClip } from './09-photo-clip.js';

/**
 * 04-assemble: the only place semantic ids become timestamps or durations.
 * The Director supplies a segment_id (real footage), a narration_id (agent-
 * written text already spoken by Polly), or a photo_id + pacing duration —
 * never a timestamp it invented. This module resolves every id against
 * persisted transcript/tighten/narration/photo data, renders a normalized
 * clip per segment, and concatenates. No agent-supplied timestamp or
 * measurement is ever trusted.
 */

const SEGMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

const TakeSegmentSchema = z.object({
  kind: z.literal('take'),
  segment_id: z.string().regex(SEGMENT_ID),
  role: z.enum(['hook', 'body', 'cta']),
  reason: z.string().min(1),
});

const NarrationSegmentSchema = z.object({
  kind: z.literal('narration'),
  narration_id: z.string().regex(SEGMENT_ID),
  photo_id: z.string().regex(SEGMENT_ID).optional(),
  role: z.enum(['hook', 'body', 'cta']),
  reason: z.string().min(1),
});

const PhotoSegmentSchema = z.object({
  kind: z.literal('photo'),
  photo_id: z.string().regex(SEGMENT_ID),
  duration_seconds: z.number().positive().max(10),
  caption: z.string().max(200).optional(),
  role: z.enum(['hook', 'body', 'cta']),
  reason: z.string().min(1),
});

const EditPlanSchema = z.object({
  objective: z.string().optional(),
  target_duration_seconds: z.number().positive().optional(),
  output_format: z.enum(['mp4', 'mov']).default('mp4'),
  brand_config: z
    .object({
      width: z.number().int().positive().max(1920).optional(),
      height: z.number().int().positive().max(1920).optional(),
      fps: z.number().int().positive().max(30).optional(),
    })
    .passthrough()
    .optional(),
  segments: z
    .array(z.discriminatedUnion('kind', [TakeSegmentSchema, NarrationSegmentSchema, PhotoSegmentSchema]))
    .min(1).max(60),
});

const AssembleInputSchema = z.object({
  project_id: z.string().regex(SEGMENT_ID),
  edit_plan: EditPlanSchema,
});

/**
 * @typedef {object} ResolvedTake
 * @property {string} segment_id
 * @property {string} source_file
 * @property {number} start_ms
 * @property {number} end_ms
 */

/**
 * @param {string} projectId
 * @param {string} takeId
 * @returns {Promise<string>}
 */
async function storedPathForTake(projectId, takeId) {
  const manifest = JSON.parse(await readFile(join(rawDir(projectId), 'manifest.json'), 'utf8'));
  const take = manifest.takes.find((/** @type {{ takeId: string }} */ t) => t.takeId === takeId);
  if (!take) throw new Error(`Unknown take referenced by segment_id (no ingest manifest entry): ${takeId}`);
  return take.storedPath;
}

/**
 * Resolves one semantic segment_id (a sentence_id from 02-transcribe, or a
 * fragment_id from 03b-tighten) into an exact source file + timestamp range.
 * @param {string} projectId
 * @param {string} segmentId
 * @returns {Promise<ResolvedTake>}
 */
async function resolveOneSegment(projectId, segmentId) {
  const sentenceMatch = segmentId.match(/^(.+)_s\d+$/);
  const sentenceTakeId = sentenceMatch?.[1];
  if (sentenceTakeId) {
    const takeId = sentenceTakeId;
    const transcriptPath = join(transcriptsDir(projectId), `${takeId}.json`);
    const transcript = await readFile(transcriptPath, 'utf8').then(JSON.parse).catch(() => null);
    const sentence = transcript?.sentences.find(
      (/** @type {{ sentenceId: string }} */ s) => s.sentenceId === segmentId,
    );
    if (sentence) {
      return {
        segment_id: segmentId,
        source_file: await storedPathForTake(projectId, takeId),
        start_ms: sentence.startMs,
        end_ms: sentence.endMs,
      };
    }
  }

  const fragmentMatch = segmentId.match(/^(.+)_f\d+$/);
  const fragmentTakeId = fragmentMatch?.[1];
  if (fragmentTakeId) {
    const takeId = fragmentTakeId;
    const tightenPath = join(tightenDir(projectId), `${takeId}.json`);
    const tightenRecord = await readFile(tightenPath, 'utf8').then(JSON.parse).catch(() => null);
    const fragment = tightenRecord?.fragments.find(
      (/** @type {{ fragmentId: string }} */ f) => f.fragmentId === segmentId,
    );
    if (fragment) {
      return {
        segment_id: segmentId,
        source_file: await storedPathForTake(projectId, takeId),
        start_ms: fragment.startMs,
        end_ms: fragment.endMs,
      };
    }
  }

  throw new Error(`Unable to resolve segment_id: ${segmentId}`);
}

/**
 * @param {string} projectId
 * @param {string[]} segmentIds
 * @returns {Promise<{ segments: ResolvedTake[] }>}
 */
export async function resolveSegments(projectId, segmentIds) {
  SEGMENT_ID.test(projectId);
  const segments = [];
  for (const segmentId of segmentIds) {
    segments.push(await resolveOneSegment(projectId, segmentId));
  }
  return { segments };
}

/**
 * @param {string} projectId
 * @param {string} narrationId
 * @returns {Promise<{ narrationId: string, text: string, audioPath: string, durationMs: number, words: { text: string, startMs: number, endMs: number }[] }>}
 */
async function resolveNarration(projectId, narrationId) {
  const recordPath = join(narrationDir(projectId), `${narrationId}.json`);
  const record = await readFile(recordPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!record) {
    throw new Error(`Unable to resolve narration_id: ${narrationId}. Call synthesize_narration first.`);
  }
  return record;
}

/**
 * @param {string} projectId
 * @param {string} photoId
 * @returns {Promise<string>}
 */
async function resolvePhotoPath(projectId, photoId) {
  const manifest = await readFile(join(photosDir(projectId), 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
  const photo = manifest?.photos.find((/** @type {{ photoId: string }} */ p) => p.photoId === photoId);
  if (!photo) throw new Error(`Unable to resolve photo_id: ${photoId}. Upload/ingest it first.`);
  return photo.storedPath;
}

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const DEFAULT_FPS = 30;
const DURATION_TOLERANCE_SEC = 2;

/**
 * @param {string} sourceFile
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} outputPath
 * @param {{ width: number, height: number, fps: number }} target
 * @returns {Promise<void>}
 */
async function cutNormalizedSegment(sourceFile, startMs, endMs, outputPath, target) {
  const startSec = (startMs / 1000).toFixed(3);
  const durationSec = ((endMs - startMs) / 1000).toFixed(3);
  const vf = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${target.fps}`;
  await runFfmpeg([
    '-y',
    '-i',
    sourceFile,
    '-ss',
    startSec,
    '-t',
    durationSec,
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    outputPath,
  ]);
}

/**
 * Renders one edit-plan segment (whatever its kind) into a normalized clip
 * file and returns the timeline metadata to persist for it. This is the
 * single place where a `kind` decides how a segment becomes real media.
 * @param {string} projectId
 * @param {import('zod').infer<typeof TakeSegmentSchema> | import('zod').infer<typeof NarrationSegmentSchema> | import('zod').infer<typeof PhotoSegmentSchema>} segment
 * @param {string} segmentFile
 * @param {string} tmpDir
 * @param {{ width: number, height: number, fps: number }} target
 * @returns {Promise<{ file: string, timelineBase: Record<string, unknown>, usedId: string }>}
 */
async function buildSegmentClip(projectId, segment, segmentFile, tmpDir, target) {
  if (segment.kind === 'take') {
    const resolved = await resolveOneSegment(projectId, segment.segment_id);
    await cutNormalizedSegment(resolved.source_file, resolved.start_ms, resolved.end_ms, segmentFile, target);
    return {
      file: segmentFile,
      usedId: segment.segment_id,
      timelineBase: {
        kind: 'take',
        segment_id: segment.segment_id,
        source_file: resolved.source_file,
        source_start_ms: resolved.start_ms,
        source_end_ms: resolved.end_ms,
      },
    };
  }

  if (segment.kind === 'narration') {
    const narration = await resolveNarration(projectId, segment.narration_id);
    const visualFile = join(tmpDir, `${randomUUID().slice(0, 8)}_visual.mp4`);
    if (segment.photo_id) {
      const photoPath = await resolvePhotoPath(projectId, segment.photo_id);
      await renderPhotoClip({
        photoPath,
        durationMs: narration.durationMs,
        outputPath: visualFile,
        width: target.width,
        height: target.height,
        fps: target.fps,
      });
    } else {
      await renderBackgroundClip({
        durationMs: narration.durationMs,
        outputPath: visualFile,
        width: target.width,
        height: target.height,
        fps: target.fps,
      });
    }
    await runFfmpeg([
      '-y',
      '-i',
      visualFile,
      '-i',
      narration.audioPath,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-shortest',
      segmentFile,
    ]);
    return {
      file: segmentFile,
      usedId: segment.narration_id,
      timelineBase: {
        kind: 'narration',
        narration_id: segment.narration_id,
        text: narration.text,
        words: narration.words,
        ...(segment.photo_id ? { photo_id: segment.photo_id } : {}),
      },
    };
  }

  // kind === 'photo'
  const photoPath = await resolvePhotoPath(projectId, segment.photo_id);
  await renderPhotoClip({
    photoPath,
    durationMs: segment.duration_seconds * 1000,
    outputPath: segmentFile,
    width: target.width,
    height: target.height,
    fps: target.fps,
    ...(segment.caption ? { caption: segment.caption } : {}),
  });
  return {
    file: segmentFile,
    usedId: segment.photo_id,
    timelineBase: {
      kind: 'photo',
      photo_id: segment.photo_id,
      ...(segment.caption ? { caption: segment.caption } : {}),
    },
  };
}

/**
 * @typedef {object} AssembleOutput
 * @property {string} output_path
 * @property {number} duration_ms
 * @property {string[]} segments_used
 * @property {string[]} warnings
 * @property {string} manifest_path
 * @property {Record<string, unknown>[]} timeline
 */

/**
 * @param {unknown} input
 * @returns {Promise<AssembleOutput>}
 */
export async function assemble(input) {
  const { project_id: projectId, edit_plan: editPlan } = AssembleInputSchema.parse(input);

  /** @type {string[]} */
  const warnings = [];
  const target = {
    width: editPlan.brand_config?.width ?? DEFAULT_WIDTH,
    height: editPlan.brand_config?.height ?? DEFAULT_HEIGHT,
    fps: editPlan.brand_config?.fps ?? DEFAULT_FPS,
  };

  const tmpDir = await mkdtemp(join(tmpdir(), 'hishin-assemble-'));
  /** @type {Record<string, unknown>[]} */
  const timeline = [];
  const concatFiles = [];
  const segmentsUsed = [];
  try {
    let outputCursorMs = 0;
    for (const [index, segment] of editPlan.segments.entries()) {
      const segmentFile = join(tmpDir, `seg_${String(index).padStart(3, '0')}.mp4`);
      const clip = await buildSegmentClip(projectId, segment, segmentFile, tmpDir, target);
      const probed = await probeMedia(clip.file);
      timeline.push({
        ...clip.timelineBase,
        output_start_ms: outputCursorMs,
        output_end_ms: outputCursorMs + probed.durationMs,
      });
      outputCursorMs += probed.durationMs;
      concatFiles.push(clip.file);
      segmentsUsed.push(clip.usedId);
    }

    const renderId = `assemble_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const renderDir = join(rendersDir(projectId), renderId);
    await mkdir(renderDir, { recursive: true });
    const outputPath = join(renderDir, `assembled.${editPlan.output_format}`);

    const listPath = join(tmpDir, 'concat.txt');
    const listContent = concatFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listPath, listContent);
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);

    const finalProbe = await probeMedia(outputPath);
    if (editPlan.target_duration_seconds) {
      const deltaSec = Math.abs(finalProbe.durationMs / 1000 - editPlan.target_duration_seconds);
      if (deltaSec > DURATION_TOLERANCE_SEC) {
        warnings.push(
          `Assembled duration ${(finalProbe.durationMs / 1000).toFixed(1)}s differs from target ${editPlan.target_duration_seconds}s by ${deltaSec.toFixed(1)}s`,
        );
      }
    }

    const manifestPath = join(renderDir, 'manifest.json');
    const manifest = {
      projectId,
      renderId,
      editPlan,
      timeline,
      outputPath,
      durationMs: finalProbe.durationMs,
      warnings,
      createdAt: new Date().toISOString(),
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    return {
      output_path: outputPath,
      duration_ms: finalProbe.durationMs,
      segments_used: segmentsUsed,
      warnings,
      manifest_path: manifestPath,
      timeline,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
