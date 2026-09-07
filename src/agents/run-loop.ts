import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appendTrace } from '../observability/traces.js';
import { computeCost } from '../observability/usage.js';
import { recordRun } from '../state/project-store.js';
import { runCritic } from './critic.js';
import { runDirector } from './director.js';
import type { Critique } from '../contracts/critique.js';

export interface OrchestrateInput {
  jobId?: string;
  projectId: string;
  brief: string;
  /** The text that was meant to be said during filming — a reference, distinct from the brief. */
  script?: string;
  targetDurationSeconds: number;
  outputFormat: 'mp4' | 'mov';
  takeIds: string[];
  /** Uploaded photo_ids available for photo/narration segments. */
  photoIds?: string[];
  /** Opt-in only: whether the Director may generate Polly voice-over narration for this run. */
  allowNarration?: boolean;
}

export interface OrchestrateRound {
  round: number;
  directorSummary: string;
  outputPath: string;
  durationMs: number;
  critique: Critique;
}

export interface OrchestrateResult {
  finalOutputPath: string;
  finalDurationMs: number;
  verdict: 'PASS' | 'REVISE';
  rounds: OrchestrateRound[];
}

/** Strips SRT indices and timestamp lines, keeping only the spoken dialogue in order. */
function extractSrtDialogue(srt: string): string {
  return srt
    .split('\n')
    .filter((line) => line.trim() && !/^\d+$/.test(line.trim()) && !line.includes('-->'))
    .join('\n');
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const maxRounds = Number(process.env.MAX_REVISION_ROUNDS ?? 2);
  const rounds: OrchestrateRound[] = [];
  let revisionNotes: string | undefined;

  for (let round = 1; round <= maxRounds + 1; round += 1) {
    const { agent: directorAgent, result: directorResult, sink } = await runDirector({
      projectId: input.projectId,
      brief: input.brief,
      targetDurationSeconds: input.targetDurationSeconds,
      outputFormat: input.outputFormat,
      takeIds: input.takeIds,
      ...(input.script ? { script: input.script } : {}),
      ...(input.photoIds ? { photoIds: input.photoIds } : {}),
      ...(revisionNotes ? { revisionNotes } : {}),
      allowNarration: input.allowNarration ?? false,
    });

    const directorUsage = directorAgent.metrics.accumulatedUsage;
    await appendTrace(input.projectId, { role: 'director', round, event: 'invoke_complete', usage: directorUsage });

    const assembleResult = sink.assembleResults.at(-1);
    if (!assembleResult) {
      throw new Error(`Director round ${round} never called assemble_edit — no render was produced`);
    }

    const mixResult = sink.mixResults.at(-1);
    const outputPath = mixResult?.output_path ?? assembleResult.output_path;
    const durationMs = mixResult?.duration_ms ?? assembleResult.duration_ms;
    const archivePath = join(dirname(assembleResult.output_path), 'review.json');
    const review = {
      ...(input.jobId ? { jobId: input.jobId } : {}),
      round,
      directorSummary: directorResult.toString(),
      brief: input.brief,
    };
    async function saveReview(value: object) {
      await writeFile(`${archivePath}.tmp`, JSON.stringify(value, null, 2));
      await rename(`${archivePath}.tmp`, archivePath);
    }
    // Preserve the Director's decisions even if the Critic subsequently fails.
    await saveReview(review);

    const subtitleResult = sink.subtitleResults.at(-1);
    const subtitleText = subtitleResult
      ? extractSrtDialogue(await readFile(subtitleResult.srt_path, 'utf8'))
      : undefined;

    await recordRun(input.projectId, {
      role: 'director',
      round,
      outputPath,
      durationMs,
      inputTokens: directorUsage.inputTokens,
      outputTokens: directorUsage.outputTokens,
      costUsd: computeCost('director', directorUsage),
    });

    const { agent: criticAgent, critique } = await runCritic({
      brief: input.brief,
      targetDurationSeconds: input.targetDurationSeconds,
      outputPath,
      durationMs,
      ...(subtitleText ? { subtitleText } : {}),
    });

    const criticUsage = criticAgent.metrics.accumulatedUsage;
    await saveReview({ ...review, critique });
    await appendTrace(input.projectId, {
      role: 'critic',
      round,
      event: 'invoke_complete',
      usage: criticUsage,
      verdict: critique.verdict,
    });
    await recordRun(input.projectId, {
      role: 'critic',
      round,
      verdict: critique.verdict,
      outputPath,
      durationMs,
      inputTokens: criticUsage.inputTokens,
      outputTokens: criticUsage.outputTokens,
      costUsd: computeCost('critic', criticUsage),
    });

    rounds.push({
      round,
      directorSummary: directorResult.toString(),
      outputPath,
      durationMs,
      critique,
    });

    if (critique.verdict === 'PASS' || round === maxRounds + 1) {
      return { finalOutputPath: outputPath, finalDurationMs: durationMs, verdict: critique.verdict, rounds };
    }

    revisionNotes = critique.issues
      .map((issue) => `[${issue.severity}/${issue.category}] ${issue.description}${issue.suggestion ? ` — Suggestion: ${issue.suggestion}` : ''}`)
      .join('\n');
  }

  throw new Error('unreachable');
}
