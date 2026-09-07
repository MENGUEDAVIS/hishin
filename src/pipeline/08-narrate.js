import { DescribeVoicesCommand, PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { narrationDir, ensureProjectDirs } from '../media/paths.js';
import { probeMedia } from '../media/probe.js';

/**
 * 08-narrate: turns agent-written text into a real voice-over via Amazon
 * Polly. The Director chooses WHAT to say; Polly (and ffprobe, downstream)
 * determine how long saying it actually takes and exactly when each word
 * lands — never the agent. Word timing comes from Polly speech marks, the
 * same "measured, not estimated" guarantee AWS Transcribe gives real
 * dialogue.
 */

const NarrateInputSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  narrationId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
    .optional(),
  text: z.string().min(1).max(3000),
  voiceId: z.string().min(1).optional(),
  engine: z.enum(['standard', 'neural', 'generative', 'long-form']).optional(),
  languageCode: z.string().min(2).optional(),
});

/**
 * @typedef {object} NarrateDeps
 * @property {InstanceType<typeof PollyClient>} [pollyClient]
 */

/**
 * @typedef {object} NarrationWord
 * @property {string} text
 * @property {number} startMs
 * @property {number} endMs
 */

/**
 * @typedef {object} NarrateOutput
 * @property {string} projectId
 * @property {string} narrationId
 * @property {string} text
 * @property {string} audioPath
 * @property {number} durationMs
 * @property {string} voiceId
 * @property {string} engine
 * @property {NarrationWord[]} words
 */

let counter = 0;
/** @returns {string} */
function defaultNarrationId() {
  counter += 1;
  return `narration_${Date.now()}_${counter}`;
}

/**
 * @param {InstanceType<typeof PollyClient>} client
 * @param {{ text: string, voiceId: string, engine: string, languageCode?: string }} opts
 * @returns {Promise<NarrationWord[]>}
 */
async function fetchSpeechMarks(client, opts) {
  const result = await client.send(
    new SynthesizeSpeechCommand({
      Text: opts.text,
      OutputFormat: 'json',
      VoiceId: /** @type {any} */ (opts.voiceId),
      Engine: /** @type {any} */ (opts.engine),
      SpeechMarkTypes: ['word'],
      ...(opts.languageCode ? { LanguageCode: /** @type {any} */ (opts.languageCode) } : {}),
    }),
  );
  const body = await result.AudioStream?.transformToString();
  if (!body) return [];
  const marks = body
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return marks.map((mark, index) => ({
    text: mark.value,
    startMs: mark.time,
    endMs: marks[index + 1] ? marks[index + 1].time : mark.time,
  }));
}

/**
 * @param {unknown} input
 * @param {NarrateDeps} [deps]
 * @returns {Promise<NarrateOutput>}
 */
export async function synthesizeNarration(input, deps = {}) {
  const parsed = NarrateInputSchema.parse(input);
  const region = process.env.AWS_REGION || 'us-east-1';
  const client = deps.pollyClient ?? new PollyClient({ region });
  const voiceId = parsed.voiceId ?? 'Lea';
  const engine = parsed.engine ?? 'neural';
  const narrationId = parsed.narrationId ?? defaultNarrationId();

  await ensureProjectDirs(parsed.projectId);

  const audioResult = await client.send(
    new SynthesizeSpeechCommand({
      Text: parsed.text,
      OutputFormat: 'mp3',
      VoiceId: /** @type {any} */ (voiceId),
      Engine: /** @type {any} */ (engine),
      ...(parsed.languageCode ? { LanguageCode: /** @type {any} */ (parsed.languageCode) } : {}),
    }),
  );
  const audioBytes = await audioResult.AudioStream?.transformToByteArray();
  if (!audioBytes) throw new Error('Polly returned no audio data');

  const audioPath = join(narrationDir(parsed.projectId), `${narrationId}.mp3`);
  await writeFile(audioPath, audioBytes);

  const [{ durationMs }, words] = await Promise.all([
    probeMedia(audioPath),
    fetchSpeechMarks(client, {
      text: parsed.text,
      voiceId,
      engine,
      ...(parsed.languageCode ? { languageCode: parsed.languageCode } : {}),
    }).catch(() => /** @type {NarrationWord[]} */ ([])),
  ]);

  if (words.length > 0) {
    const last = words.at(-1);
    if (last) last.endMs = durationMs;
  }

  const record = {
    projectId: parsed.projectId,
    narrationId,
    text: parsed.text,
    audioPath,
    durationMs,
    voiceId,
    engine,
    words,
    synthesizedAt: new Date().toISOString(),
  };
  await writeFile(join(narrationDir(parsed.projectId), `${narrationId}.json`), JSON.stringify(record, null, 2));

  return { projectId: parsed.projectId, narrationId, text: parsed.text, audioPath, durationMs, voiceId, engine, words };
}

/**
 * @typedef {object} VoiceInfo
 * @property {string} id
 * @property {string} gender
 * @property {string} languageCode
 * @property {string[]} engines
 */

/**
 * @param {{ languageCode?: string, pollyClient?: InstanceType<typeof PollyClient> }} [input]
 * @returns {Promise<{ voices: VoiceInfo[] }>}
 */
export async function listVoices(input = {}) {
  const region = process.env.AWS_REGION || 'us-east-1';
  const client = input.pollyClient ?? new PollyClient({ region });
  const languageCode = input.languageCode ?? 'fr-FR';
  const result = await client.send(
    new DescribeVoicesCommand({ LanguageCode: /** @type {any} */ (languageCode) }),
  );
  const voices = (result.Voices ?? []).map((v) => ({
    id: /** @type {string} */ (v.Id),
    gender: /** @type {string} */ (v.Gender),
    languageCode: /** @type {string} */ (v.LanguageCode),
    engines: /** @type {string[]} */ (v.SupportedEngines ?? []),
  }));
  return { voices };
}
