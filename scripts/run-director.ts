import { orchestrate } from '../src/agents/run-loop.js';

/**
 * Runs the full Director <-> Critic agentic loop against an already-ingested
 * project and prints the result. Requires AWS credentials with Bedrock
 * invoke access, and BEDROCK_DIRECTOR_MODEL_ID / BEDROCK_CRITIC_MODEL_ID set.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/run-director.ts \
 *     <projectId> "<brief>" <targetDurationSeconds> <mp4|mov> <take_id> [take_id...]
 */

async function main() {
  const [projectId, brief, targetDurationSecondsRaw, outputFormatRaw, ...takeIds] = process.argv.slice(2);
  if (!projectId || !brief || !targetDurationSecondsRaw || takeIds.length === 0) {
    console.error(
      'Usage: node --env-file=.env --import tsx scripts/run-director.ts <projectId> "<brief>" <targetDurationSeconds> <mp4|mov> <take_id> [take_id...]',
    );
    process.exitCode = 1;
    return;
  }

  const outputFormat = outputFormatRaw === 'mov' ? 'mov' : 'mp4';

  const result = await orchestrate({
    projectId,
    brief,
    targetDurationSeconds: Number(targetDurationSecondsRaw),
    outputFormat,
    takeIds,
  });

  console.log('\n=== Résultat ===');
  for (const round of result.rounds) {
    console.log(`\n--- Round ${round.round} (${round.critique.verdict}) ---`);
    console.log(`Director: ${round.directorSummary}`);
    console.log(`Render: ${round.outputPath} (${round.durationMs} ms)`);
    console.log(`Critique: ${round.critique.summary}`);
    for (const issue of round.critique.issues) {
      console.log(`  [${issue.severity}/${issue.category}] ${issue.description}${issue.suggestion ? ` -> ${issue.suggestion}` : ''}`);
    }
  }

  console.log(`\nFinal (${result.verdict}): ${result.finalOutputPath}`);
  console.log(result.finalOutputPath);
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
