import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { generateFixtureMedia, segmentBoundariesMs } from '../../scripts/generate-fixtures.js';
import { ingest } from '../../src/pipeline/01-ingest.js';
import { tighten } from '../../src/pipeline/03b-tighten.js';
import { assemble } from '../../src/pipeline/04-assemble.js';
import { generateSubtitles } from '../../src/pipeline/05-subtitles.js';
import { prepareSoundLibrary } from '../../src/pipeline/06-sound-library.js';
import { mix } from '../../src/pipeline/07-mix.js';
import { segmentSentences } from '../../src/media/timeline.js';
import { probeMedia } from '../../src/media/probe.js';
import { runFfmpeg } from '../../src/media/ffmpeg.js';
import { soundLibraryDir, transcriptsDir } from '../../src/media/paths.js';

/**
 * Full run of the deterministic pipeline against a real ffmpeg-generated
 * clip: ingest -> (hand-authored transcript, standing in for AWS
 * Transcribe) -> tighten -> assemble -> subtitles. Every timestamp
 * asserted here comes from ffprobe/ffmpeg measurement, proving the
 * modules are independently testable and actually cut/concatenate media
 * correctly — not pseudo-code.
 *
 * 02-transcribe and 07-mix are exercised separately (AWS credentials and
 * curated audio assets respectively are out of scope for this suite; see
 * docs/architecture.md).
 */

const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']).status === 0;
const describeIfFfmpeg = ffmpegAvailable ? describe : describe.skip;

describeIfFfmpeg('deterministic media pipeline (real ffmpeg)', () => {
  jest.setTimeout(60_000);

  const projectId = 'proj_media_workflow_test';
  const takeId = 'take_01';
  /** @type {string} */
  let dataDir;
  /** @type {string | undefined} */
  let originalDataDir;

  /** @type {import('../../scripts/generate-fixtures.js').FixtureSegment[]} */
  const segments = [
    { type: 'tone', durationSec: 1.5, freq: 440 },
    { type: 'silence', durationSec: 1.0 },
    { type: 'tone', durationSec: 1.2, freq: 523 },
    { type: 'silence', durationSec: 0.6 },
  ];
  const boundaries = segmentBoundariesMs(segments);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hishin-data-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    const fixturePath = join(dataDir, 'fixture-source', 'clip.mp4');
    await generateFixtureMedia(fixturePath, segments);

    await ingest({ projectId, sources: [{ path: fixturePath, takeId }] });

    const firstTone = boundaries[0];
    const secondTone = boundaries[2];
    if (!firstTone || !secondTone) throw new Error('fixture segment boundaries missing');
    const words = [
      { text: 'Bonjour', startMs: firstTone.startMs, endMs: firstTone.startMs + 400 },
      { text: 'le', startMs: firstTone.startMs + 450, endMs: firstTone.startMs + 600 },
      { text: 'monde.', startMs: firstTone.startMs + 650, endMs: firstTone.endMs },
      { text: 'Deuxième', startMs: secondTone.startMs, endMs: secondTone.startMs + 400 },
      { text: 'phrase.', startMs: secondTone.startMs + 450, endMs: secondTone.endMs },
    ];
    const sentences = segmentSentences(words, takeId);
    await mkdir(transcriptsDir(projectId), { recursive: true });
    await writeFile(
      join(transcriptsDir(projectId), `${takeId}.json`),
      JSON.stringify({ projectId, takeId, languageCode: 'fr-FR', words, sentences }, null, 2),
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  test('01-ingest extracts real ffprobe metadata for the synthetic clip', async () => {
    const manifest = JSON.parse(
      await readFile(join(dataDir, 'projects', projectId, 'raw', 'manifest.json'), 'utf8'),
    );
    const take = manifest.takes[0];
    expect(take.mediaMetadata.hasVideo).toBe(true);
    expect(take.mediaMetadata.hasAudio).toBe(true);
    expect(take.durationMs).toBeGreaterThan(4000);
    expect(take.durationMs).toBeLessThan(4600);
  });

  /** @type {Awaited<ReturnType<typeof tighten>>} */
  let tightenResult;
  test('03b-tighten removes the two measured silences with a margin', async () => {
    tightenResult = await tighten({ projectId, takeId });
    expect(tightenResult.fragments.length).toBeGreaterThanOrEqual(1);
    expect(tightenResult.removedMs).toBeGreaterThan(300);
    expect(tightenResult.tightDurationMs).toBeLessThan(tightenResult.originalDurationMs);

    const firstFragment = tightenResult.fragments[0];
    if (!firstFragment) throw new Error('expected at least one tightened fragment');
    expect(firstFragment.includesSentenceIds).toContain(`${takeId}_s01`);
  });

  /** @type {Awaited<ReturnType<typeof assemble>>} */
  let assembleResult;
  test('04-assemble resolves a sentence_id and a fragment_id, then cuts and concatenates', async () => {
    const fragmentIds = tightenResult.fragments.map(
      (/** @type {{ fragmentId: string }} */ f) => f.fragmentId,
    );
    const bodyFragmentId = fragmentIds.at(-1);
    if (!bodyFragmentId) throw new Error('expected at least one tightened fragment id');

    assembleResult = await assemble({
      project_id: projectId,
      edit_plan: {
        output_format: 'mp4',
        segments: [
          { kind: 'take', segment_id: `${takeId}_s01`, role: 'hook', reason: 'opening sentence' },
          { kind: 'take', segment_id: bodyFragmentId, role: 'body', reason: 'tightened remainder' },
        ],
      },
    });

    expect(assembleResult.segments_used).toEqual([`${takeId}_s01`, bodyFragmentId]);
    expect(assembleResult.timeline).toHaveLength(2);

    const probed = await probeMedia(assembleResult.output_path);
    expect(probed.hasVideo).toBe(true);
    expect(probed.hasAudio).toBe(true);
    expect(Math.abs(probed.durationMs - assembleResult.duration_ms)).toBeLessThan(150);
  });

  /** @type {Awaited<ReturnType<typeof generateSubtitles>>} */
  let subtitles;
  test('05-subtitles projects word timing onto the assembled output', async () => {
    subtitles = await generateSubtitles({
      project_id: projectId,
      manifest_path: assembleResult.manifest_path,
    });

    expect(subtitles.cue_count).toBeGreaterThan(0);
    const srt = await readFile(subtitles.srt_path, 'utf8');
    expect(srt).toContain('Bonjour');
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);

    const vtt = await readFile(subtitles.vtt_path, 'utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
  });

  test('07-mix combines music (with ducking) and soft subtitles without misordering ffmpeg args', async () => {
    const padPath = join(soundLibraryDir(), 'regression-pad.wav');
    await runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:d=6',
      '-af', 'volume=0.2',
      padPath,
    ]);
    const soundResult = await prepareSoundLibrary({
      project_id: projectId,
      requests: [{ cue_id: 'pad', type: 'music', filename: 'regression-pad.wav', license: 'test fixture' }],
    });
    const padAsset = soundResult.assets[0];
    if (!padAsset) throw new Error('expected a prepared sound asset');

    const mixResult = await mix({
      project_id: projectId,
      video_path: assembleResult.output_path,
      music: { stored_path: padAsset.stored_path, volume_db: -20 },
      subtitles_path: subtitles.srt_path,
      target_lufs: -14,
    });

    expect(mixResult.warnings).toEqual([]);
    const probed = await probeMedia(mixResult.output_path);
    expect(probed.hasVideo).toBe(true);
    expect(probed.hasAudio).toBe(true);
    expect(Math.abs(probed.durationMs - mixResult.duration_ms)).toBeLessThan(150);
    expect(mixResult.loudness_measured).not.toBeNull();
  });
});
