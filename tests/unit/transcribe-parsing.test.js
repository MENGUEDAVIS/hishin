import { readFile } from 'node:fs/promises';
import { describe, expect, test } from '@jest/globals';
import { itemsToWords } from '../../src/pipeline/02-transcribe.js';
import { segmentSentences } from '../../src/media/timeline.js';

/**
 * Uses a static AWS Transcribe-shaped fixture (no network, no credentials)
 * to prove the punctuation-attachment and sentence-segmentation logic that
 * turns Transcribe's word-level output into our sentence contract.
 */

describe('AWS Transcribe result parsing', () => {
  test('attaches punctuation to the preceding word and converts seconds to ms', async () => {
    const fixture = JSON.parse(await readFile('tests/fixtures/transcript.json', 'utf8'));
    const words = itemsToWords(fixture.results.items);

    expect(words).toHaveLength(9);
    expect(words[3]).toMatchObject({ text: 'monde.', startMs: 850, endMs: 1200 });
    expect(words.at(-1)).toMatchObject({ text: "aujourd'hui.", startMs: 2950, endMs: 3400 });
  });

  test('segments the parsed words into two sentences on punctuation', async () => {
    const fixture = JSON.parse(await readFile('tests/fixtures/transcript.json', 'utf8'));
    const words = itemsToWords(fixture.results.items);
    const sentences = segmentSentences(words, 'take_fixture');

    expect(sentences).toHaveLength(2);
    expect(sentences.at(0)?.text).toBe('Bonjour tout le monde.');
    expect(sentences.at(1)?.text).toBe("On lance le produit aujourd'hui.");
  });
});
