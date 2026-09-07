import { ingest } from '../src/pipeline/01-ingest.js';
import { transcribe } from '../src/pipeline/02-transcribe.js';
import { derush } from '../src/pipeline/03-derush.js';

/**
 * One-shot helper: ingest a set of raw video files into a project, run real
 * AWS Transcribe on every take (in parallel), then run derush across all of
 * them. Complements scripts/pipeline.js (which expects a project/take to
 * already exist) for the common "I have N raw rushes, get me transcripts
 * and flags" case.
 *
 * Usage: node --env-file=.env scripts/run-project.js <projectId> <file1> <file2> ...
 */

async function main() {
  const [projectId, ...files] = process.argv.slice(2);
  if (!projectId || files.length === 0) {
    console.error('Usage: node --env-file=.env scripts/run-project.js <projectId> <file1> <file2> ...');
    process.exitCode = 1;
    return;
  }

  const sources = files.map((path, index) => ({
    path,
    takeId: `take_${String(index + 1).padStart(2, '0')}`,
  }));

  console.log(`Ingesting ${sources.length} file(s) into project "${projectId}"...`);
  const ingestResult = await ingest({ projectId, sources });
  for (const take of ingestResult.takes) {
    console.log(`  ${take.takeId}: ${take.sourcePath} -> ${take.durationMs} ms, ${take.mediaMetadata.hasAudio ? 'audio ok' : 'NO AUDIO'}`);
  }
  if (ingestResult.warnings.length) console.log('  warnings:', ingestResult.warnings);

  console.log(`\nTranscribing ${sources.length} take(s) via AWS Transcribe (parallel, this can take a couple of minutes)...`);
  const takeIds = sources.map((s) => s.takeId);
  const transcriptions = await Promise.all(
    takeIds.map((takeId) =>
      transcribe({ projectId, takeId }).then(
        (result) => ({ takeId, ok: /** @type {true} */ (true), result }),
        (error) => ({ takeId, ok: /** @type {false} */ (false), error: /** @type {Error} */ (error).message }),
      ),
    ),
  );

  const transcribedTakeIds = [];
  for (const entry of transcriptions) {
    if (!entry.ok) {
      console.error(`  ${entry.takeId}: FAILED — ${entry.error}`);
      continue;
    }
    transcribedTakeIds.push(entry.takeId);
    const { sentences, words, warnings } = entry.result;
    console.log(`  ${entry.takeId}: ${words.length} mots, ${sentences.length} phrases`);
    for (const sentence of sentences) {
      console.log(`    [${sentence.sentenceId}] (${sentence.startMs}-${sentence.endMs}ms) ${sentence.text}`);
    }
    if (warnings.length) console.log('    warnings:', warnings);
  }

  if (transcribedTakeIds.length === 0) {
    console.error('\nNo take was transcribed successfully; skipping derush.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nRunning derush across ${transcribedTakeIds.length} transcribed take(s)...`);
  const derushResult = await derush({ projectId, takeIds: transcribedTakeIds });
  if (derushResult.flags.length === 0) {
    console.log('  No flags.');
  } else {
    for (const flag of derushResult.flags) {
      console.log(`  [${flag.flagType}] ${flag.takeId}${flag.sentenceId ? ' / ' + flag.sentenceId : ''} (score ${flag.score}) — ${flag.explanation}`);
    }
  }
  if (derushResult.duplicateGroups.length === 0) {
    console.log('  No duplicate sentence groups.');
  } else {
    for (const group of derushResult.duplicateGroups) {
      console.log(`  duplicate group ${group.groupId} (similarity ${group.similarity}):`);
      for (const member of group.members) {
        console.log(`    ${member.takeId}/${member.sentenceId}: ${member.text}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
