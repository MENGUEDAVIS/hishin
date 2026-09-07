import { describe, expect, test } from '@jest/globals';
import {
  buildSubtitleCues,
  clampMs,
  mergeIntervals,
  msToSrtTimestamp,
  msToVttTimestamp,
  segmentSentences,
  subtractIntervals,
  sumDurationMs,
} from '../../src/media/timeline.js';

describe('msToSrtTimestamp / msToVttTimestamp', () => {
  test('formats zero', () => {
    expect(msToSrtTimestamp(0)).toBe('00:00:00,000');
    expect(msToVttTimestamp(0)).toBe('00:00:00.000');
  });

  test('formats hours, minutes, seconds, millis', () => {
    const ms = (1 * 3_600_000) + (2 * 60_000) + (3 * 1000) + 456;
    expect(msToSrtTimestamp(ms)).toBe('01:02:03,456');
    expect(msToVttTimestamp(ms)).toBe('01:02:03.456');
  });

  test('clamps negative input to zero', () => {
    expect(msToSrtTimestamp(-500)).toBe('00:00:00,000');
  });
});

describe('clampMs', () => {
  test('clamps within bounds', () => {
    expect(clampMs(50, 0, 100)).toBe(50);
    expect(clampMs(-10, 0, 100)).toBe(0);
    expect(clampMs(150, 0, 100)).toBe(100);
  });
});

describe('mergeIntervals', () => {
  test('merges overlapping and touching intervals', () => {
    const merged = mergeIntervals([
      { startMs: 0, endMs: 100 },
      { startMs: 90, endMs: 200 },
      { startMs: 300, endMs: 400 },
    ]);
    expect(merged).toEqual([
      { startMs: 0, endMs: 200 },
      { startMs: 300, endMs: 400 },
    ]);
  });

  test('drops zero-length or inverted intervals', () => {
    expect(mergeIntervals([{ startMs: 10, endMs: 10 }, { startMs: 20, endMs: 5 }])).toEqual([]);
  });
});

describe('subtractIntervals', () => {
  test('removes a middle chunk', () => {
    const result = subtractIntervals({ startMs: 0, endMs: 1000 }, [{ startMs: 400, endMs: 600 }]);
    expect(result).toEqual([
      { startMs: 0, endMs: 400 },
      { startMs: 600, endMs: 1000 },
    ]);
  });

  test('removes overlapping edges and multiple cuts', () => {
    const result = subtractIntervals({ startMs: 0, endMs: 1000 }, [
      { startMs: -100, endMs: 100 },
      { startMs: 900, endMs: 1200 },
      { startMs: 400, endMs: 500 },
    ]);
    expect(result).toEqual([
      { startMs: 100, endMs: 400 },
      { startMs: 500, endMs: 900 },
    ]);
  });

  test('returns the base interval untouched when nothing overlaps', () => {
    const result = subtractIntervals({ startMs: 0, endMs: 1000 }, [{ startMs: 2000, endMs: 3000 }]);
    expect(result).toEqual([{ startMs: 0, endMs: 1000 }]);
  });
});

describe('sumDurationMs', () => {
  test('sums interval lengths', () => {
    expect(
      sumDurationMs([
        { startMs: 0, endMs: 100 },
        { startMs: 200, endMs: 250 },
      ]),
    ).toBe(150);
  });
});

describe('segmentSentences', () => {
  test('splits on terminal punctuation', () => {
    const words = [
      { text: 'Bonjour', startMs: 0, endMs: 300 },
      { text: 'tout', startMs: 300, endMs: 500 },
      { text: 'le', startMs: 500, endMs: 600 },
      { text: 'monde.', startMs: 600, endMs: 900 },
      { text: 'Ça', startMs: 950, endMs: 1100 },
      { text: 'va?', startMs: 1100, endMs: 1300 },
    ];
    const sentences = segmentSentences(words, 'take_01');
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({
      sentenceId: 'take_01_s01',
      text: 'Bonjour tout le monde.',
      startMs: 0,
      endMs: 900,
    });
    expect(sentences[1]).toMatchObject({
      sentenceId: 'take_01_s02',
      text: 'Ça va?',
      startMs: 950,
      endMs: 1300,
    });
  });

  test('splits on a long silent gap even without punctuation', () => {
    const words = [
      { text: 'un', startMs: 0, endMs: 200 },
      { text: 'deux', startMs: 200, endMs: 400 },
      { text: 'trois', startMs: 2000, endMs: 2200 },
    ];
    const sentences = segmentSentences(words, 'take_02', { maxGapMs: 500 });
    expect(sentences).toHaveLength(2);
    expect(sentences.at(0)?.text).toBe('un deux');
    expect(sentences.at(1)?.text).toBe('trois');
  });

  test('returns nothing for an empty word list', () => {
    expect(segmentSentences([], 'take_03')).toEqual([]);
  });
});

describe('buildSubtitleCues', () => {
  test('splits when the character limit would be exceeded', () => {
    const words = Array.from({ length: 20 }, (_, i) => ({
      text: `word${i}`,
      startMs: i * 200,
      endMs: i * 200 + 150,
    }));
    const cues = buildSubtitleCues(words, { maxCharsPerCue: 30, maxDurationMs: 100_000, maxGapMs: 100_000 });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(30);
    }
  });

  test('splits on a large gap between words', () => {
    const words = [
      { text: 'a', startMs: 0, endMs: 100 },
      { text: 'b', startMs: 100, endMs: 200 },
      { text: 'c', startMs: 5000, endMs: 5100 },
    ];
    const cues = buildSubtitleCues(words, { maxGapMs: 500 });
    expect(cues).toEqual([
      { startMs: 0, endMs: 200, text: 'a b' },
      { startMs: 5000, endMs: 5100, text: 'c' },
    ]);
  });
});
