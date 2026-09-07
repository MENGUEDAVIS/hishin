/**
 * Pure timing and text-segmentation helpers. No file or process I/O here,
 * so every function is trivially unit-testable and side-effect free.
 */

/** @param {number} ms @returns {string} "HH:MM:SS,mmm" */
export function msToSrtTimestamp(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (/** @type {number} */ n, /** @type {number} */ len = 2) => String(n).padStart(len, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/** @param {number} ms @returns {string} "HH:MM:SS.mmm" */
export function msToVttTimestamp(ms) {
  return msToSrtTimestamp(ms).replace(',', '.');
}

/** @param {number} value @param {number} min @param {number} max @returns {number} */
export function clampMs(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * @typedef {object} Interval
 * @property {number} startMs
 * @property {number} endMs
 */

/**
 * @param {Interval[]} intervals
 * @returns {Interval[]} sorted, non-overlapping, merged intervals
 */
export function mergeIntervals(intervals) {
  const sorted = [...intervals]
    .filter((iv) => iv.endMs > iv.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  /** @type {Interval[]} */
  const merged = [];
  for (const iv of sorted) {
    const last = merged.at(-1);
    if (last && iv.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, iv.endMs);
    } else {
      merged.push({ startMs: iv.startMs, endMs: iv.endMs });
    }
  }
  return merged;
}

/**
 * Subtracts a set of intervals from a single base interval.
 * @param {Interval} base
 * @param {Interval[]} toSubtract
 * @returns {Interval[]} remaining pieces of base, in order
 */
export function subtractIntervals(base, toSubtract) {
  const cuts = mergeIntervals(toSubtract).filter(
    (iv) => iv.endMs > base.startMs && iv.startMs < base.endMs,
  );
  /** @type {Interval[]} */
  const remaining = [];
  let cursor = base.startMs;
  for (const cut of cuts) {
    const cutStart = Math.max(cut.startMs, base.startMs);
    const cutEnd = Math.min(cut.endMs, base.endMs);
    if (cutStart > cursor) {
      remaining.push({ startMs: cursor, endMs: cutStart });
    }
    cursor = Math.max(cursor, cutEnd);
  }
  if (cursor < base.endMs) {
    remaining.push({ startMs: cursor, endMs: base.endMs });
  }
  return remaining;
}

/** @param {Interval[]} intervals @returns {number} */
export function sumDurationMs(intervals) {
  return intervals.reduce((total, iv) => total + (iv.endMs - iv.startMs), 0);
}

/**
 * Expands an interval by a margin, clamped to [floorMs, ceilMs].
 * @param {Interval} interval
 * @param {number} marginMs
 * @param {number} floorMs
 * @param {number} ceilMs
 * @returns {Interval}
 */
export function applyMargin(interval, marginMs, floorMs, ceilMs) {
  return {
    startMs: clampMs(interval.startMs - marginMs, floorMs, ceilMs),
    endMs: clampMs(interval.endMs + marginMs, floorMs, ceilMs),
  };
}

/**
 * @typedef {object} Word
 * @property {string} text
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} [confidence]
 */

/**
 * @typedef {object} Sentence
 * @property {string} sentenceId
 * @property {string} text
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} wordStartIndex
 * @property {number} wordEndIndex
 */

const SENTENCE_END = /[.!?…]["')\]]*$/;

/**
 * Groups words into sentences deterministically: a sentence ends at
 * terminal punctuation, or after a silent gap longer than maxGapMs.
 * Boundaries are computed from transcript timing/punctuation only —
 * never inferred or adjusted by a language model.
 * @param {Word[]} words
 * @param {string} takeId
 * @param {{ maxGapMs?: number }} [opts]
 * @returns {Sentence[]}
 */
export function segmentSentences(words, takeId, opts = {}) {
  const maxGapMs = opts.maxGapMs ?? 700;
  /** @type {Sentence[]} */
  const sentences = [];
  /** @type {Word[]} */
  let buffer = [];
  let bufferStartIndex = 0;
  let sentenceCount = 0;

  const flush = (/** @type {number} */ endIndex) => {
    const first = buffer[0];
    const last = buffer.at(-1);
    if (!first || !last) return;
    sentenceCount += 1;
    sentences.push({
      sentenceId: `${takeId}_s${String(sentenceCount).padStart(2, '0')}`,
      text: buffer.map((w) => w.text).join(' '),
      startMs: first.startMs,
      endMs: last.endMs,
      wordStartIndex: bufferStartIndex,
      wordEndIndex: endIndex,
    });
    buffer = [];
  };

  words.forEach((word, index) => {
    if (buffer.length === 0) {
      bufferStartIndex = index;
    } else {
      const lastBuffered = buffer.at(-1);
      const gap = lastBuffered ? word.startMs - lastBuffered.endMs : 0;
      if (gap > maxGapMs) {
        flush(index - 1);
        bufferStartIndex = index;
      }
    }
    buffer.push(word);
    if (SENTENCE_END.test(word.text)) {
      flush(index);
    }
  });
  flush(words.length - 1);

  return sentences;
}

/**
 * @typedef {object} SubtitleCue
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} text
 */

/**
 * Groups already-positioned words into readable subtitle cues using fixed,
 * deterministic limits (max characters, max duration, max silent gap).
 * @param {Word[]} words
 * @param {{ maxCharsPerCue?: number, maxDurationMs?: number, maxGapMs?: number }} [opts]
 * @returns {SubtitleCue[]}
 */
export function buildSubtitleCues(words, opts = {}) {
  const maxCharsPerCue = opts.maxCharsPerCue ?? 84;
  const maxDurationMs = opts.maxDurationMs ?? 7000;
  const maxGapMs = opts.maxGapMs ?? 800;

  /** @type {SubtitleCue[]} */
  const cues = [];
  /** @type {Word[]} */
  let buffer = [];

  const flush = () => {
    const first = buffer[0];
    const last = buffer.at(-1);
    if (!first || !last) return;
    cues.push({
      startMs: first.startMs,
      endMs: last.endMs,
      text: buffer.map((w) => w.text).join(' '),
    });
    buffer = [];
  };

  for (const word of words) {
    const prev = buffer.at(-1);
    if (buffer.length > 0) {
      const firstBuffered = buffer[0];
      const candidateText = [...buffer, word].map((w) => w.text).join(' ');
      const candidateDuration = firstBuffered ? word.endMs - firstBuffered.startMs : 0;
      const gap = prev ? word.startMs - prev.endMs : 0;
      if (candidateText.length > maxCharsPerCue || candidateDuration > maxDurationMs || gap > maxGapMs) {
        flush();
      }
    }
    buffer.push(word);
  }
  flush();

  return cues;
}
