import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { ingest } from '../../src/pipeline/01-ingest.js';
import { assemble, resolveSegments } from '../../src/pipeline/04-assemble.js';
import { prepareSoundLibrary } from '../../src/pipeline/06-sound-library.js';

/**
 * These tests only exercise input validation and failure paths that don't
 * need ffmpeg or fixture media — fast checks that each module rejects
 * malformed structured input before touching any file. See
 * tests/integration/media-workflow.test.js for the real ffmpeg-backed run.
 *
 * Some failure paths (a missing source file, a sound asset absent from the
 * library) still throw after ensureProjectDirs() has run, so DATA_DIR is
 * pointed at a throwaway temp directory for the whole file — these tests
 * must never write into the project's real data/ directory.
 */

/** @type {string} */
let dataDir;
/** @type {string | undefined} */
let originalDataDir;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'hishin-pipeline-unit-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe('01-ingest input validation', () => {
  test('rejects a project id with unsafe characters', async () => {
    await expect(ingest({ projectId: '../evil', sources: [{ path: '/tmp/x.mp4' }] })).rejects.toThrow();
  });

  test('rejects an empty sources array', async () => {
    await expect(ingest({ projectId: 'proj_1', sources: [] })).rejects.toThrow();
  });

  test('rejects a missing source file', async () => {
    await expect(
      ingest({ projectId: 'proj_missing', sources: [{ path: '/nonexistent/does-not-exist.mp4' }] }),
    ).rejects.toThrow(/not found/);
  });
});

describe('04-assemble input validation', () => {
  test('rejects an edit plan with no segments', async () => {
    await expect(
      assemble({ project_id: 'proj_1', edit_plan: { output_format: 'mp4', segments: [] } }),
    ).rejects.toThrow();
  });

  test('rejects a segment with an invalid role', async () => {
    await expect(
      assemble({
        project_id: 'proj_1',
        edit_plan: {
          output_format: 'mp4',
          segments: [{ kind: 'take', segment_id: 'take_01_s01', role: 'outro', reason: 'x' }],
        },
      }),
    ).rejects.toThrow();
  });

  test('resolveSegments rejects an unresolvable segment_id', async () => {
    await expect(resolveSegments('proj_never_ingested', ['take_99_s01'])).rejects.toThrow(
      /Unable to resolve segment_id/,
    );
  });
});

describe('06-sound-library input validation', () => {
  test('rejects a filename attempting path traversal', async () => {
    await expect(
      prepareSoundLibrary({
        project_id: 'proj_1',
        requests: [{ cue_id: 'music_01', type: 'music', filename: '../../etc/passwd', license: 'n/a' }],
      }),
    ).rejects.toThrow();
  });

  test('rejects a request for an asset that is not in the local library', async () => {
    await expect(
      prepareSoundLibrary({
        project_id: 'proj_1',
        requests: [{ cue_id: 'music_01', type: 'music', filename: 'does-not-exist.mp3', license: 'n/a' }],
      }),
    ).rejects.toThrow(/not found in local library/);
  });
});
