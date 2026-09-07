import { runFfmpeg, probeJson } from './ffmpeg.js';

/**
 * @typedef {object} StreamInfo
 * @property {string} codec
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [fps]
 * @property {number} [sampleRate]
 * @property {number} [channels]
 */

/**
 * @typedef {object} MediaMetadata
 * @property {number} durationMs
 * @property {number} sizeBytes
 * @property {string} formatName
 * @property {boolean} hasVideo
 * @property {boolean} hasAudio
 * @property {StreamInfo} [video]
 * @property {StreamInfo} [audio]
 */

/**
 * @param {string} rFrameRate e.g. "30000/1001"
 * @returns {number}
 */
function parseFrameRate(rFrameRate) {
  const parts = rFrameRate.split('/').map(Number);
  const num = parts[0] ?? 0;
  const den = parts[1] ?? 0;
  if (!den) return 0;
  return num / den;
}

/**
 * Extracts deterministic media metadata via ffprobe. No AI, no estimation.
 * @param {string} filePath
 * @returns {Promise<MediaMetadata>}
 */
export async function probeMedia(filePath) {
  const raw = /** @type {any} */ (
    await probeJson(['-show_format', '-show_streams', filePath])
  );
  const format = raw.format ?? {};
  /** @type {any[]} */
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const formatDurationSec = Number(format.duration ?? 0);
  const streamDurationSec = Number(videoStream?.duration ?? audioStream?.duration ?? 0);
  const durationSec = formatDurationSec > 0 ? formatDurationSec : streamDurationSec;

  /** @type {MediaMetadata} */
  const metadata = {
    durationMs: Math.round(durationSec * 1000),
    sizeBytes: Number(format.size ?? 0),
    formatName: String(format.format_name ?? 'unknown'),
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
  };
  if (videoStream) {
    metadata.video = {
      codec: String(videoStream.codec_name ?? 'unknown'),
      width: Number(videoStream.width ?? 0),
      height: Number(videoStream.height ?? 0),
      fps: parseFrameRate(String(videoStream.r_frame_rate ?? '0/1')),
    };
  }
  if (audioStream) {
    metadata.audio = {
      codec: String(audioStream.codec_name ?? 'unknown'),
      sampleRate: Number(audioStream.sample_rate ?? 0),
      channels: Number(audioStream.channels ?? 0),
    };
  }
  return metadata;
}

/**
 * @typedef {object} SilenceInterval
 * @property {number} startMs
 * @property {number} endMs
 */

/**
 * Detects silence intervals with ffmpeg's silencedetect filter. Boundaries
 * come from signal analysis, never from a language model.
 * @param {string} filePath
 * @param {{ noiseDb?: number, minDurationSec?: number }} [opts]
 * @returns {Promise<SilenceInterval[]>}
 */
export async function detectSilence(filePath, opts = {}) {
  const noiseDb = opts.noiseDb ?? -30;
  const minDurationSec = opts.minDurationSec ?? 0.4;
  const { stderr } = await runFfmpeg([
    '-i',
    filePath,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`,
    '-f',
    'null',
    '-',
  ]);

  /** @type {SilenceInterval[]} */
  const intervals = [];
  let pendingStartSec = /** @type {number | null} */ (null);
  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) {
      pendingStartSec = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (endMatch && pendingStartSec !== null) {
      const endSec = Number(endMatch[1]);
      intervals.push({
        startMs: Math.round(pendingStartSec * 1000),
        endMs: Math.round(endSec * 1000),
      });
      pendingStartSec = null;
    }
  }
  return intervals;
}
