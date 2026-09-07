import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, BedrockModel, ImageBlock, TextBlock, type Model } from '@strands-agents/sdk';
import { CritiqueSchema, type Critique } from '../contracts/critique.js';
import { extractFrame } from '../media/ffmpeg.js';
import { CRITIC_SYSTEM_PROMPT } from './prompts.js';

export interface CriticRunInput {
  brief: string;
  targetDurationSeconds?: number;
  outputPath: string;
  durationMs: number;
  subtitleText?: string;
  /** Test-only override — injects a scripted Model instead of real Bedrock. */
  model?: Model;
}

function defaultCriticModel(): Model {
  const modelId = process.env.BEDROCK_CRITIC_MODEL_ID;
  if (!modelId) throw new Error('BEDROCK_CRITIC_MODEL_ID is not configured');
  return new BedrockModel({
    region: process.env.AWS_REGION || 'us-east-1',
    modelId,
    maxTokens: 2048,
    temperature: 0.2,
  });
}

function createCriticAgent(model: Model): Agent {
  return new Agent({
    name: 'hi-shin-critic',
    model,
    systemPrompt: CRITIC_SYSTEM_PROMPT,
    structuredOutputSchema: CritiqueSchema,
  });
}

export async function runCritic(input: CriticRunInput): Promise<{ agent: Agent; critique: Critique }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'hishin-critic-'));
  try {
    const fractions = [0.1, 0.5, 0.85];
    const frameBlocks: ImageBlock[] = [];
    for (const [index, fraction] of fractions.entries()) {
      const framePath = join(tmpDir, `frame_${index}.jpg`);
      await extractFrame(input.outputPath, Math.round(input.durationMs * fraction), framePath);
      const bytes = await readFile(framePath);
      frameBlocks.push(new ImageBlock({ format: 'jpeg', source: { bytes: new Uint8Array(bytes) } }));
    }

    const durationSeconds = input.durationMs / 1000;
    const targetLine = input.targetDurationSeconds
      ? `Target duration: ${input.targetDurationSeconds}s. Actual measured duration: ${durationSeconds.toFixed(1)}s (delta ${(durationSeconds - input.targetDurationSeconds).toFixed(1)}s).`
      : `Actual measured duration: ${durationSeconds.toFixed(1)}s (no target was set).`;

    const textBlock = new TextBlock(
      [
        `Brief: ${input.brief}`,
        targetLine,
        input.subtitleText
          ? `Subtitle text actually spoken, in order:\n${input.subtitleText}`
          : 'No subtitles were generated for this render.',
        `You are shown ${frameBlocks.length} frames sampled from the render (at ~10%, 50%, 85% of its duration) to judge visual/brand consistency.`,
      ].join('\n\n'),
    );

    const agent = createCriticAgent(input.model ?? defaultCriticModel());
    const result = await agent.invoke([textBlock, ...frameBlocks]);
    if (!result.structuredOutput) {
      throw new Error('Critic did not return structured output');
    }
    return { agent, critique: result.structuredOutput as Critique };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
