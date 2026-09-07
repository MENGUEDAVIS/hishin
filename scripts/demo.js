import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateFixtureMedia, segmentBoundariesMs } from './generate-fixtures.js';
import { runFfmpeg } from '../src/media/ffmpeg.js';
import { ingest } from '../src/pipeline/01-ingest.js';
import { tighten } from '../src/pipeline/03b-tighten.js';
import { assemble } from '../src/pipeline/04-assemble.js';
import { generateSubtitles } from '../src/pipeline/05-subtitles.js';
import { prepareSoundLibrary } from '../src/pipeline/06-sound-library.js';
import { mix } from '../src/pipeline/07-mix.js';
import { segmentSentences } from '../src/media/timeline.js';
import { soundLibraryDir, transcriptsDir } from '../src/media/paths.js';

/**
 * Local, no-AWS demo of the full deterministic pipeline: generates a
 * synthetic "take" with real silences, tightens it, assembles a hook/body/
 * cta edit from mixed sentence_id + fragment_id segment references,
 * projects subtitles, and mixes in a locally-generated music bed with
 * ducking. Produces a real playable final.mp4 under data/projects/demo_live.
 *
 * 02-transcribe and real speech recognition are out of scope here (no AWS
 * configured) — the transcript below is hand-authored to match the
 * synthetic tone timing exactly, standing in for what Transcribe would
 * return.
 */

const projectId = 'demo_live';
const takeId = 'take_01';

async function main() {
  console.log('--- HI-SHIN — démo locale du pipeline (étape 2) ---\n');

  const sourcePath = join(process.env.DATA_DIR || './data', 'demo-assets', 'source.mp4');
  /** @type {import('./generate-fixtures.js').FixtureSegment[]} */
  const segments = [
    { type: 'tone', durationSec: 1.8, freq: 440 },
    { type: 'silence', durationSec: 1.3 },
    { type: 'tone', durationSec: 2.2, freq: 330 },
    { type: 'silence', durationSec: 1.0 },
    { type: 'tone', durationSec: 1.5, freq: 523 },
    { type: 'silence', durationSec: 0.6 },
  ];
  console.log('1/8  Génération du clip source synthétique (ffmpeg testsrc + sine)...');
  await generateFixtureMedia(sourcePath, segments);
  const boundaries = segmentBoundariesMs(segments);

  console.log('2/8  01-ingest...');
  const ingestResult = await ingest({ projectId, sources: [{ path: sourcePath, takeId }] });
  const ingestedTake = ingestResult.takes[0];
  if (!ingestedTake) throw new Error('ingest produced no take');
  console.log(`     take_01 ingéré, durée mesurée par ffprobe: ${ingestedTake.durationMs} ms`);

  console.log('3/8  Écriture du transcript (texte réel calé sur le timing des tons — pas AWS ici)...');
  const tone1 = boundaries[0];
  const tone2 = boundaries[2];
  const tone3 = boundaries[4];
  if (!tone1 || !tone2 || !tone3) throw new Error('expected 3 tone segments in fixture boundaries');
  const words = [
    { text: 'Bonjour', startMs: tone1.startMs, endMs: tone1.startMs + 350 },
    { text: 'et', startMs: tone1.startMs + 400, endMs: tone1.startMs + 500 },
    { text: 'bienvenue', startMs: tone1.startMs + 550, endMs: tone1.startMs + 1000 },
    { text: 'chez', startMs: tone1.startMs + 1050, endMs: tone1.startMs + 1250 },
    { text: 'HI-SHIN.', startMs: tone1.startMs + 1300, endMs: tone1.endMs },

    { text: 'On', startMs: tone2.startMs, endMs: tone2.startMs + 150 },
    { text: 'retire', startMs: tone2.startMs + 200, endMs: tone2.startMs + 550 },
    { text: 'les', startMs: tone2.startMs + 600, endMs: tone2.startMs + 750 },
    { text: 'silences', startMs: tone2.startMs + 800, endMs: tone2.startMs + 1300 },
    { text: 'automatiquement,', startMs: tone2.startMs + 1350, endMs: tone2.startMs + 2000 },
    { text: 'sans', startMs: tone2.startMs + 2050, endMs: tone2.startMs + 2200 },
    { text: 'jamais', startMs: tone2.startMs + 2200, endMs: tone2.endMs },

    { text: 'Merci', startMs: tone3.startMs, endMs: tone3.startMs + 350 },
    { text: "d'avoir", startMs: tone3.startMs + 400, endMs: tone3.startMs + 650 },
    { text: 'regardé,', startMs: tone3.startMs + 700, endMs: tone3.startMs + 1100 },
    { text: 'à', startMs: tone3.startMs + 1150, endMs: tone3.startMs + 1200 },
    { text: 'bientôt !', startMs: tone3.startMs + 1250, endMs: tone3.endMs },
  ];
  const sentences = segmentSentences(words, takeId);
  await mkdir(transcriptsDir(projectId), { recursive: true });
  await writeFile(
    join(transcriptsDir(projectId), `${takeId}.json`),
    JSON.stringify({ projectId, takeId, languageCode: 'fr-FR', words, sentences }, null, 2),
  );
  console.log(`     ${sentences.length} phrases: ${sentences.map((s) => s.sentenceId).join(', ')}`);

  console.log('4/8  03b-tighten (silencedetect ffmpeg réel)...');
  const tightenResult = await tighten({ projectId, takeId });
  console.log(
    `     ${tightenResult.originalDurationMs} ms -> ${tightenResult.tightDurationMs} ms (${tightenResult.removedMs} ms de silence retirés), fragments: ${tightenResult.fragments.map((f) => f.fragmentId).join(', ')}`,
  );

  console.log('5/8  04-assemble (hook=sentence_id, body=fragment_id, cta=sentence_id)...');
  const bodyFragment = tightenResult.fragments.find((f) => f.includesSentenceIds.includes(`${takeId}_s02`));
  if (!bodyFragment) throw new Error('no tightened fragment covers the body sentence');
  const assembleResult = await assemble({
    project_id: projectId,
    edit_plan: {
      objective: 'Démo locale du pipeline HI-SHIN',
      output_format: 'mp4',
      segments: [
        { kind: 'take', segment_id: `${takeId}_s01`, role: 'hook', reason: "Accroche d'ouverture" },
        { kind: 'take', segment_id: bodyFragment.fragmentId, role: 'body', reason: 'Corps du message, silences retirés' },
        { kind: 'take', segment_id: `${takeId}_s03`, role: 'cta', reason: 'Appel à l\'action final' },
      ],
    },
  });
  console.log(`     rendu: ${assembleResult.output_path} (${assembleResult.duration_ms} ms)`);

  console.log('6/8  05-subtitles (projection des mots sur la timeline assemblée)...');
  const subtitles = await generateSubtitles({ project_id: projectId, manifest_path: assembleResult.manifest_path });
  console.log(`     ${subtitles.cue_count} cues -> ${subtitles.srt_path}`);

  console.log('7/8  06-sound-library (fichier local généré pour la démo, aucun fetch réseau)...');
  const padPath = join(soundLibraryDir(), 'demo-pad.wav');
  await mkdir(soundLibraryDir(), { recursive: true });
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:d=8',
    '-f', 'lavfi', '-i', 'sine=frequency=277:sample_rate=44100:d=8',
    '-filter_complex', 'amix=inputs=2:duration=first,volume=0.25',
    padPath,
  ]);
  const soundResult = await prepareSoundLibrary({
    project_id: projectId,
    requests: [
      {
        cue_id: 'pad',
        type: 'music',
        filename: 'demo-pad.wav',
        license: 'Généré localement pour la démo (deux sinusoïdes ffmpeg) — aucun droit tiers',
      },
    ],
  });

  console.log('8/8  07-mix (ducking + loudnorm + sous-titres soft-mux)...');
  const padAsset = soundResult.assets[0];
  if (!padAsset) throw new Error('sound library preparation produced no asset');
  const mixResult = await mix({
    project_id: projectId,
    video_path: assembleResult.output_path,
    music: { stored_path: padAsset.stored_path, volume_db: -20 },
    subtitles_path: subtitles.srt_path,
    target_lufs: -14,
  });

  console.log('\n--- Terminé ---');
  console.log(`Rendu final : ${mixResult.output_path}`);
  console.log(`Durée: ${mixResult.duration_ms} ms`);
  console.log('Loudness mesurée:', mixResult.loudness_measured);
  if (mixResult.warnings.length) console.log('Avertissements:', mixResult.warnings);

  return mixResult.output_path;
}

main()
  .then((outputPath) => {
    process.stdout.write(`\n${outputPath}\n`);
  })
  .catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
