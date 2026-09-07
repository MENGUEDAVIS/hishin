import { Agent, BedrockModel, type Model } from '@strands-agents/sdk';
import { createRunSink, type RunSink } from './run-sink.js';
import { DIRECTOR_SYSTEM_PROMPT } from './prompts.js';
import { createDirectorTools } from '../tools/registry.js';

export interface DirectorRunInput {
  projectId: string;
  brief: string;
  /** The text that was meant to be said during filming — a reference, distinct from the brief. */
  script?: string;
  targetDurationSeconds: number;
  outputFormat: 'mp4' | 'mov';
  takeIds: string[];
  /** Uploaded photo_ids available for photo/narration segments. */
  photoIds?: string[];
  revisionNotes?: string;
  /** Test-only override — injects a scripted Model instead of real Bedrock. */
  model?: Model;
}

function defaultDirectorModel(): Model {
  const modelId = process.env.BEDROCK_DIRECTOR_MODEL_ID;
  if (!modelId) throw new Error('BEDROCK_DIRECTOR_MODEL_ID is not configured');
  return new BedrockModel({
    region: process.env.AWS_REGION || 'us-east-1',
    modelId,
    maxTokens: 4096,
    temperature: 0.4,
  });
}

function createDirectorAgent(projectId: string, sink: RunSink, model: Model): Agent {
  return new Agent({
    name: 'hi-shin-director',
    model,
    systemPrompt: DIRECTOR_SYSTEM_PROMPT,
    tools: createDirectorTools(projectId, sink),
  });
}

export async function runDirector(input: DirectorRunInput) {
  const sink = createRunSink();
  const agent = createDirectorAgent(input.projectId, sink, input.model ?? defaultDirectorModel());

  const prompt = [
    `Project brief (creative direction): ${input.brief}`,
    input.script
      ? `Script (text intended to be said on camera — a reference, not necessarily what was actually said):\n${input.script}`
      : '',
    `Target duration: ${input.targetDurationSeconds} seconds`,
    `Output format: ${input.outputFormat}`,
    `Ingested take_ids: ${input.takeIds.join(', ')}`,
    input.photoIds && input.photoIds.length > 0 ? `Available photo_ids: ${input.photoIds.join(', ')}` : '',
    input.revisionNotes
      ? `\nThe previous cut was reviewed and needs revision. Critic feedback:\n${input.revisionNotes}\nAddress every blocker issue before calling assemble_edit again.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await agent.invoke(prompt, { limits: { turns: 20 } });
  return { agent, result, sink };
}
