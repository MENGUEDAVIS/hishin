// Run only as an explicit ECS smoke task. Uses synthetic media and tiny AWS requests.
// Bedrock / Polly / Transcribe incur small usage charges. No customer data is used.
import { DatabaseSync } from 'node:sqlite';
import { readFile, rm } from 'node:fs/promises';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { runFfmpeg, probeJson } from './src/media/ffmpeg.js';

const db = new DatabaseSync('/data/.deployment-check.sqlite');
db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS checks (at TEXT);');
db.prepare('INSERT INTO checks VALUES (?)').run(new Date().toISOString());
console.log('SMOKE EFS_SQLITE_OK', db.prepare('SELECT COUNT(*) AS count FROM checks').get());
db.close();
await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10', '-t', '1', '-c:v', 'libx264', '/tmp/smoke.mp4']);
await probeJson(['-show_format', '/tmp/smoke.mp4']);
console.log('SMOKE FFMPEG_OK');
const bedrock = new BedrockRuntimeClient({});
for (const id of [process.env.BEDROCK_DIRECTOR_MODEL_ID, process.env.BEDROCK_CRITIC_MODEL_ID]) {
  const result = await bedrock.send(new ConverseCommand({ modelId: id, messages: [{ role: 'user', content: [{ text: 'Reply OK.' }] }], inferenceConfig: { maxTokens: 16 } }));
  console.log('SMOKE BEDROCK_OK', id, result.usage?.outputTokens);
}
const voice = await new PollyClient({}).send(new SynthesizeSpeechCommand({ Text: 'Bonjour.', OutputFormat: 'pcm', VoiceId: 'Lea', Engine: 'neural' }));
await voice.AudioStream?.transformToByteArray();
console.log('SMOKE POLLY_OK');
await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '/tmp/smoke.wav']);
const jobName = `hishin-deployment-smoke-${Date.now()}`;
const key = `hishin/smoke/${jobName}.wav`;
await new S3Client({}).send(new PutObjectCommand({ Bucket: process.env.TRANSCRIBE_S3_BUCKET, Key: key, Body: await readFile('/tmp/smoke.wav') }));
const transcribe = new TranscribeClient({});
await transcribe.send(new StartTranscriptionJobCommand({ TranscriptionJobName: jobName, LanguageCode: 'fr-FR', MediaFormat: 'wav', Media: { MediaFileUri: `s3://${process.env.TRANSCRIBE_S3_BUCKET}/${key}` } }));
let completed = false;
for (let attempt = 0; attempt < 60; attempt++) {
  const result = await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }));
  if (result.TranscriptionJob?.TranscriptionJobStatus === 'FAILED') throw new Error(result.TranscriptionJob.FailureReason);
  if (result.TranscriptionJob?.TranscriptionJobStatus === 'COMPLETED') { completed = true; break; }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (!completed) throw new Error('Transcribe smoke timed out');
console.log('SMOKE TRANSCRIBE_OK', jobName);
await Promise.all(['/tmp/smoke.mp4', '/tmp/smoke.wav'].map(path => rm(path, { force: true })));
console.log('SMOKE ALL_OK');
