import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { generateFixtureMedia, segmentBoundariesMs } from '../../scripts/generate-fixtures.js';
import { ingest } from '../../src/pipeline/01-ingest.js';
import { ingestPhotos } from '../../src/pipeline/01b-ingest-photos.js';
import { synthesizeNarration } from '../../src/pipeline/08-narrate.js';
import { tighten } from '../../src/pipeline/03b-tighten.js';
import { runFfmpeg } from '../../src/media/ffmpeg.js';
import { segmentSentences } from '../../src/media/timeline.js';
import { transcriptsDir } from '../../src/media/paths.js';
import { runDirector } from '../../src/agents/director.js';
import { runCritic } from '../../src/agents/critic.js';
import { ScriptedModel } from '../helpers/scripted-model.js';

/**
 * Proves, without any network access or AWS/Bedrock credentials (except
 * where noted), that:
 *  1. the Director agent actually drives real tool calls in sequence against
 *     real ffmpeg-backed pipeline modules and produces a real rendered file;
 *  2. the STRICT RULE holds even under adversarial pressure — an assemble_edit
 *     call referencing a segment_id that was never resolved from a real
 *     transcript/tighten fragment fails loudly and produces no render;
 *  3. the Critic agent runs against a real rendered file (real frame
 *     extraction) and returns the scripted structured verdict;
 *  4. a plan mixing "take", "narration", and "photo" segment kinds resolves
 *     and renders correctly through the real Strands `tool()` wrapper — the
 *     one place proving the discriminated-union schema survives conversion
 *     to a JSON schema for the model, not just direct JS calls. This one
 *     test does call real Amazon Polly (synthesize_narration) — a fraction
 *     of a cent, not mocked, same standard as AWS Transcribe elsewhere in
 *     this repo's integration tests.
 *
 * Run with: npm run test:agents (a plain tsx script, not a Jest suite — see
 * docs/architecture.md for why Jest's resolver can't follow tsx's .ts
 * loading here).
 */

let passed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.error(`  FAIL - ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  }
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hishin-agent-tools-'));
  const originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  const projectId = 'proj_agent_tools_test';
  const takeId = 'take_01';

  try {
    const fixturePath = join(dataDir, 'fixture-source', 'clip.mp4');
    const segments = [
      { type: 'tone' as const, durationSec: 1.2, freq: 440 },
      { type: 'silence' as const, durationSec: 0.8 },
      { type: 'tone' as const, durationSec: 1.0, freq: 523 },
    ];
    await generateFixtureMedia(fixturePath, segments);
    const boundaries = segmentBoundariesMs(segments);
    const tone1 = boundaries[0];
    const tone2 = boundaries[2];
    if (!tone1 || !tone2) throw new Error('expected two tone segments');

    await ingest({ projectId, sources: [{ path: fixturePath, takeId }] });

    const words = [
      { text: 'Bonjour.', startMs: tone1.startMs, endMs: tone1.startMs + 400 },
      { text: 'Merci.', startMs: tone2.startMs, endMs: tone2.startMs + 300 },
    ];
    const sentences = segmentSentences(words, takeId);
    await mkdir(transcriptsDir(projectId), { recursive: true });
    await writeFile(
      join(transcriptsDir(projectId), `${takeId}.json`),
      JSON.stringify({ projectId, takeId, languageCode: 'fr-FR', words, sentences }),
    );
    await tighten({ projectId, takeId });

    await test('Director drives inspect_take then assemble_edit and produces a real render', async () => {
      const model = new ScriptedModel([
        { type: 'tool_calls', calls: [{ name: 'inspect_take', input: { take_id: takeId } }] },
        {
          type: 'tool_calls',
          calls: [
            {
              name: 'assemble_edit',
              input: {
                output_format: 'mp4',
                segments: [
                  { kind: 'take', segment_id: `${takeId}_s01`, role: 'hook', reason: 'test' },
                  { kind: 'take', segment_id: `${takeId}_s02`, role: 'cta', reason: 'test' },
                ],
              },
            },
          ],
        },
        { type: 'text', text: 'Assembled the two sentences.' },
      ]);

      const { result, sink } = await runDirector({
        projectId,
        brief: 'test brief',
        targetDurationSeconds: 2,
        outputFormat: 'mp4',
        takeIds: [takeId],
        model,
      });

      assert.equal(result.stopReason, 'endTurn');
      assert.equal(sink.assembleResults.length, 1, 'assemble_edit should have run exactly once');

      const rendered = sink.assembleResults[0];
      assert.ok(rendered);
      const info = await stat(rendered.output_path);
      assert.ok(info.isFile(), 'assemble_edit must produce a real file on disk');
      assert.ok(rendered.duration_ms > 0);

      // The second model call's messages must contain the inspect_take tool
      // result before the assemble_edit call was made — proving real
      // sequencing, not just a lucky final state.
      const secondCallMessages = model.callHistory[1];
      assert.ok(secondCallMessages);
      const hasInspectResult = secondCallMessages.some(
        (m) =>
          m.role === 'user' &&
          m.content.some((block) => block.type === 'toolResultBlock' && block.toolUseId === 'scripted_0_0'),
      );
      assert.ok(hasInspectResult, 'assemble_edit call must have been made after seeing inspect_take result');
    });

    await test('STRICT RULE: an unresolvable segment_id fails the tool call and produces no render', async () => {
      const model = new ScriptedModel([
        {
          type: 'tool_calls',
          calls: [
            {
              name: 'assemble_edit',
              input: {
                output_format: 'mp4',
                segments: [
                  { kind: 'take', segment_id: 'take_99_s01_never_existed', role: 'hook', reason: 'adversarial' },
                ],
              },
            },
          ],
        },
        { type: 'text', text: 'That failed as expected.' },
      ]);

      const { sink } = await runDirector({
        projectId,
        brief: 'test brief',
        targetDurationSeconds: 2,
        outputFormat: 'mp4',
        takeIds: [takeId],
        model,
      });

      assert.equal(sink.assembleResults.length, 0, 'no render should exist when the segment_id cannot be resolved');

      const toolResultMessage = model.callHistory[1]?.at(-1);
      assert.ok(toolResultMessage);
      const toolResultBlock = toolResultMessage.content.find((b) => b.type === 'toolResultBlock');
      assert.ok(toolResultBlock && toolResultBlock.type === 'toolResultBlock');
      assert.equal(toolResultBlock.status, 'error');
      const errorText = JSON.stringify(toolResultBlock.content);
      assert.match(errorText, /Unable to resolve segment_id/);
    });

    await test('mixed take + narration + photo segments resolve and render through the real tool layer', async () => {
      const photoPath = join(dataDir, 'photo-source.jpg');
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x480:d=1', '-frames:v', '1', photoPath]);
      const photoResult = await ingestPhotos({ projectId, sources: [{ path: photoPath, photoId: 'photo_01' }] });
      const photo = photoResult.photos[0];
      assert.ok(photo);

      const narration = await synthesizeNarration({ projectId, text: 'Merci et à bientôt.' });
      assert.ok(narration.durationMs > 0);
      assert.ok(narration.words.length > 0, 'Polly speech marks should produce word-level timing');

      const model = new ScriptedModel([
        {
          type: 'tool_calls',
          calls: [
            {
              name: 'assemble_edit',
              input: {
                output_format: 'mp4',
                segments: [
                  { kind: 'take', segment_id: `${takeId}_s01`, role: 'hook', reason: 'test' },
                  {
                    kind: 'narration',
                    narration_id: narration.narrationId,
                    photo_id: photo.photoId,
                    role: 'cta',
                    reason: 'generated cta the raw footage lacks',
                  },
                ],
              },
            },
          ],
        },
        { type: 'text', text: 'Mixed-kind edit assembled.' },
      ]);

      const { sink } = await runDirector({
        projectId,
        brief: 'test brief',
        targetDurationSeconds: 2,
        outputFormat: 'mp4',
        takeIds: [takeId],
        photoIds: [photo.photoId],
        model,
      });

      assert.equal(sink.assembleResults.length, 1);
      const rendered = sink.assembleResults[0];
      assert.ok(rendered);
      const info = await stat(rendered.output_path);
      assert.ok(info.isFile());
      assert.deepEqual(rendered.segments_used, [`${takeId}_s01`, narration.narrationId]);

      const manifest = JSON.parse(await readFile(rendered.manifest_path, 'utf8'));
      assert.equal(manifest.timeline[0].kind, 'take');
      assert.equal(manifest.timeline[1].kind, 'narration');
      assert.equal(manifest.timeline[1].photo_id, photo.photoId);
    });

    await test('Critic runs real frame extraction against a real render and returns the scripted verdict', async () => {
      const rendered = await import('../../src/media/probe.js').then(({ probeMedia }) =>
        probeMedia(join(dataDir, 'projects', projectId, 'raw', `${takeId}.mp4`)),
      );

      const model = new ScriptedModel([
        {
          type: 'tool_calls',
          calls: [
            {
              name: 'strands_structured_output',
              input: { verdict: 'PASS', summary: 'Scripted verdict for test', issues: [] },
            },
          ],
        },
      ]);

      const { critique } = await runCritic({
        brief: 'test brief',
        targetDurationSeconds: 2,
        outputPath: join(dataDir, 'projects', projectId, 'raw', `${takeId}.mp4`),
        durationMs: rendered.durationMs,
        model,
      });

      assert.equal(critique.verdict, 'PASS');
      assert.equal(critique.summary, 'Scripted verdict for test');
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  }

  console.log(`\n${passed} passed`);
  if (process.exitCode) {
    console.error('Some agent-tools checks failed.');
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
