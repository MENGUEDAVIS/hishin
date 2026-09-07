import { spawn } from 'node:child_process';

/** @returns {string} */
export function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/** @returns {string} */
export function ffprobePath() {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

/**
 * @typedef {object} RunResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode
 */

/**
 * Runs an executable with an argument array, never through a shell.
 * @param {string} executable
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<RunResult>}
 */
function run(executable, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, timeout: opts.timeoutMs ?? Number(process.env.MEDIA_TIMEOUT_MS || 120_000) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      reject(new Error(`Failed to spawn ${executable}: ${error.message}`));
    });
    child.on('close', (exitCode) => {
      const code = exitCode ?? -1;
      if (code !== 0) {
        const tail = stderr.split('\n').slice(-20).join('\n');
        reject(new Error(`${executable} exited with code ${code}\n${tail}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<RunResult>}
 */
export function runFfmpeg(args, opts) {
  return run(ffmpegPath(), process.env.NODE_ENV === 'production' ? ['-protocol_whitelist', 'file,pipe', '-threads', '1', ...args] : args, opts);
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<RunResult>}
 */
export function runFfprobe(args, opts) {
  return run(ffprobePath(), process.env.NODE_ENV === 'production' ? ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,avi,image2,jpeg_pipe,png_pipe,webp_pipe,wav,mp3,flac,ogg', ...args] : args, opts);
}

/**
 * Runs ffprobe with -print_format json and parses the result.
 * @param {string[]} args
 * @returns {Promise<unknown>}
 */
export async function probeJson(args) {
  const { stdout } = await runFfprobe(['-v', 'error', '-print_format', 'json', ...args]);
  return JSON.parse(stdout);
}

/**
 * Extracts a single JPEG frame at an exact timestamp — used by the Critic
 * agent to look at real rendered frames, never a hallucinated description.
 * @param {string} videoPath
 * @param {number} atMs
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
export async function extractFrame(videoPath, atMs, outputPath) {
  await runFfmpeg(['-y', '-ss', (atMs / 1000).toFixed(3), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outputPath]);
}

/**
 * Makes a string safe to embed as a single-quoted drawtext `text` value.
 * Empirically, this ffmpeg build's filter-option parser still splits on an
 * unescaped `:` even inside single quotes (colon-escaping tricks from the
 * usual ffmpeg tutorials did not work here), so risky characters are
 * dropped rather than escaped — acceptable for the short captions this is
 * used for (a product name, a CTA), not a place for arbitrary text.
 * @param {string} text
 * @returns {string}
 */
export function escapeDrawtextValue(text) {
  return text
    .replace(/[\\:%]/g, ' ')
    .replace(/'/g, '’')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
