import { GetTranscriptionJobCommand, StartTranscriptionJobCommand, TranscribeClient } from '@aws-sdk/client-transcribe';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runFfmpeg } from '../media/ffmpeg.js';
import { segmentSentences } from '../media/timeline.js';
import { rawDir, transcriptsDir } from '../media/paths.js';

/**
 * 02-transcribe: extracts audio locally with ffmpeg, then delegates word-level
 * timestamping to AWS Transcribe. Sentence boundaries are derived afterwards
 * by deterministic code (media/timeline.js), never by a language model.
 */

const TranscribeInputSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  takeId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  languageCode: z.string().min(2).optional(),
});

/**
 * @typedef {object} TranscribeDeps
 * @property {InstanceType<typeof S3Client>} [s3Client]
 * @property {InstanceType<typeof TranscribeClient>} [transcribeClient]
 * @property {number} [pollIntervalMs]
 * @property {number} [pollTimeoutMs]
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {object} TranscriptWord
 * @property {string} text
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} confidence
 */

/**
 * @typedef {object} TranscribeOutput
 * @property {string} projectId
 * @property {string} takeId
 * @property {string} transcriptPath
 * @property {TranscriptWord[]} words
 * @property {import('../media/timeline.js').Sentence[]} sentences
 * @property {string[]} warnings
 */

/**
 * @param {string} projectId
 * @param {string} takeId
 * @returns {Promise<string>}
 */
async function findStoredTakePath(projectId, takeId) {
  const manifestPath = join(rawDir(projectId), 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const take = manifest.takes.find((/** @type {{ takeId: string }} */ t) => t.takeId === takeId);
  if (!take) {
    throw new Error(`Unknown takeId (not found in ingest manifest): ${takeId}`);
  }
  return take.storedPath;
}

/**
 * Extracts a mono 16kHz WAV suitable for AWS Transcribe.
 * @param {string} sourcePath
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function extractAudio(sourcePath, outputPath) {
  await runFfmpeg([
    '-y',
    '-i',
    sourcePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);
}

/**
 * Converts AWS Transcribe's raw `results.items` array into words, attaching
 * punctuation items to the preceding word. Exported standalone so this
 * parsing logic is unit-testable without AWS credentials or ffmpeg.
 * @param {any[]} items AWS Transcribe result items
 * @returns {TranscriptWord[]}
 */
export function itemsToWords(items) {
  /** @type {TranscriptWord[]} */
  const words = [];
  for (const item of items) {
    const alt = item.alternatives?.[0];
    if (!alt) continue;
    if (item.type === 'punctuation') {
      const last = words.at(-1);
      if (last) last.text += alt.content;
      continue;
    }
    words.push({
      text: alt.content,
      startMs: Math.round(Number(item.start_time ?? 0) * 1000),
      endMs: Math.round(Number(item.end_time ?? 0) * 1000),
      confidence: Number(alt.confidence ?? 0),
    });
  }
  return words;
}

/**
 * @param {InstanceType<typeof TranscribeClient>} client
 * @param {string} jobName
 * @param {number} pollIntervalMs
 * @param {number} pollTimeoutMs
 * @returns {Promise<string>} transcript file URI
 */
async function waitForJob(client, jobName, pollIntervalMs, pollTimeoutMs) {
  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const { TranscriptionJob } = await client.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
    );
    const status = TranscriptionJob?.TranscriptionJobStatus;
    if (status === 'COMPLETED') {
      const uri = TranscriptionJob?.Transcript?.TranscriptFileUri;
      if (!uri) throw new Error(`Transcribe job ${jobName} completed without a transcript URI`);
      return uri;
    }
    if (status === 'FAILED') {
      throw new Error(`Transcribe job ${jobName} failed: ${TranscriptionJob?.FailureReason ?? 'unknown reason'}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Transcribe job ${jobName} timed out after ${pollTimeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * @param {unknown} input
 * @param {TranscribeDeps} [deps]
 * @returns {Promise<TranscribeOutput>}
 */
export async function transcribe(input, deps = {}) {
  const { projectId, takeId, languageCode } = TranscribeInputSchema.parse(input);
  const bucket = process.env.TRANSCRIBE_S3_BUCKET;
  if (!bucket) throw new Error('TRANSCRIBE_S3_BUCKET is not configured');

  const region = process.env.AWS_REGION || 'us-east-1';
  const s3Client = deps.s3Client ?? new S3Client({ region });
  const transcribeClient = deps.transcribeClient ?? new TranscribeClient({ region });
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 15 * 60_000;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const language = languageCode ?? process.env.TRANSCRIBE_LANGUAGE_CODE ?? 'fr-FR';

  /** @type {string[]} */
  const warnings = [];
  const sourcePath = await findStoredTakePath(projectId, takeId);

  const tmpDir = await mkdtemp(join(tmpdir(), 'hishin-transcribe-'));
  const audioPath = join(tmpDir, `${takeId}.wav`);
  try {
    await extractAudio(sourcePath, audioPath);

    const s3Key = `hishin/${projectId}/${takeId}.wav`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: await readFile(audioPath),
      }),
    );

    const jobName = `hishin-${projectId}-${takeId}-${Date.now()}`;
    await transcribeClient.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        LanguageCode: /** @type {any} */ (language),
        MediaFormat: 'wav',
        Media: { MediaFileUri: `s3://${bucket}/${s3Key}` },
      }),
    );

    const transcriptUri = await waitForJob(transcribeClient, jobName, pollIntervalMs, pollTimeoutMs);
    const response = await fetchImpl(transcriptUri);
    if (!response.ok) {
      throw new Error(`Failed to download transcript: HTTP ${response.status}`);
    }
    const payload = /** @type {any} */ (await response.json());
    const items = payload.results?.items ?? [];
    if (items.length === 0) {
      warnings.push(`${takeId}: Transcribe returned no items`);
    }

    const words = itemsToWords(items);
    const sentences = segmentSentences(words, takeId);

    const transcriptPath = join(transcriptsDir(projectId), `${takeId}.json`);
    const record = { projectId, takeId, languageCode: language, words, sentences };
    await writeFile(transcriptPath, JSON.stringify(record, null, 2));

    return { projectId, takeId, transcriptPath, words, sentences, warnings };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
