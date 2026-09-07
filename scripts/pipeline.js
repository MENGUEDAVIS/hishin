#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { ingest } from '../src/pipeline/01-ingest.js';
import { transcribe } from '../src/pipeline/02-transcribe.js';
import { derush } from '../src/pipeline/03-derush.js';
import { tighten } from '../src/pipeline/03b-tighten.js';
import { assemble, resolveSegments } from '../src/pipeline/04-assemble.js';
import { generateSubtitles } from '../src/pipeline/05-subtitles.js';
import { prepareSoundLibrary } from '../src/pipeline/06-sound-library.js';
import { mix } from '../src/pipeline/07-mix.js';

/**
 * Common CLI for every pipeline module: JSON in, JSON out, diagnostics on
 * stderr. Each module stays independently testable by calling its
 * exported function directly; this file is only a thin dispatcher.
 *
 * Usage: node scripts/pipeline.js <module> < input.json
 *        node scripts/pipeline.js <module> --file input.json
 */

const MODULES = {
  ingest,
  transcribe,
  derush,
  tighten,
  assemble,
  'resolve-segments': (/** @type {{ project_id: string, segment_ids: string[] }} */ input) =>
    resolveSegments(input.project_id, input.segment_ids),
  subtitles: generateSubtitles,
  'sound-library': prepareSoundLibrary,
  mix,
};

/** @returns {Promise<string>} */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [moduleName, flag, filePath] = process.argv.slice(2);
  const fn = MODULES[/** @type {keyof typeof MODULES} */ (moduleName)];
  if (!fn) {
    console.error(`Unknown module: ${moduleName}. Available: ${Object.keys(MODULES).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (flag === '--file' && !filePath) {
    console.error('--file requires a path argument');
    process.exitCode = 1;
    return;
  }
  const raw = flag === '--file' && filePath ? await readFile(filePath, 'utf8') : await readStdin();
  const input = JSON.parse(raw);

  try {
    const output = await fn(input);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    console.error(/** @type {Error} */ (error).stack ?? String(error));
    process.exitCode = 1;
  }
}

main();
