import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILLER_WORDS, normalizeText } from '../src/pipeline/03-derush.js';
import { rawDir, transcriptsDir } from '../src/media/paths.js';

/**
 * Production-quality metrics computed after a render: how much of the raw
 * footage survived, how dense the surviving speech is, how clean it reads,
 * and (if subtitles exist) whether the reading speed is realistic. Every
 * number is derived from persisted pipeline artifacts — transcripts,
 * manifests, ffprobe durations — never estimated by a model.
 */

interface TimelineEntry {
  segment_id: string;
  source_file: string;
  source_start_ms: number;
  source_end_ms: number;
}

interface AssembleManifest {
  timeline: TimelineEntry[];
  durationMs: number;
}

interface RawManifest {
  takes: { takeId: string; durationMs: number }[];
}

interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleReadingSpeed {
  cueCount: number;
  avgCharsPerSecond: number;
  maxCharsPerSecond: number;
}

export interface ProductionMetrics {
  takesAvailable: number;
  takesUsedInFinalCut: number;
  totalRawDurationMs: number;
  finalDurationMs: number;
  compressionRatio: number;
  wordsUsed: number;
  wordsPerSecond: number;
  fillerWordRatio: number;
  subtitleReadingSpeed?: SubtitleReadingSpeed;
}

/**
 * @param entry SRT/VTT cue text lines, in "HH:MM:SS,mmm --> HH:MM:SS,mmm" plus following text lines.
 */
function parseSrtCues(srt: string): { startMs: number; endMs: number; text: string }[] {
  const timestampToMs = (t: string): number => {
    const match = t.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match) return 0;
    const [, h, m, s, ms] = match;
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms);
  };

  const blocks = srt.split(/\r?\n\r?\n/).filter((b) => b.trim());
  return blocks
    .map((block) => {
      const lines = block.split(/\r?\n/).filter(Boolean);
      const timingLine = lines.find((l) => l.includes('-->'));
      if (!timingLine) return null;
      const [startRaw, endRaw] = timingLine.split('-->').map((s) => s.trim());
      const text = lines.slice(lines.indexOf(timingLine) + 1).join(' ');
      return { startMs: timestampToMs(startRaw ?? ''), endMs: timestampToMs(endRaw ?? ''), text };
    })
    .filter((cue): cue is { startMs: number; endMs: number; text: string } => cue !== null);
}

export function evaluateSubtitleReadingSpeed(srt: string): SubtitleReadingSpeed {
  const cues = parseSrtCues(srt);
  const speeds = cues
    .filter((c) => c.endMs > c.startMs)
    .map((c) => c.text.length / ((c.endMs - c.startMs) / 1000));
  const cueCount = cues.length;
  const avgCharsPerSecond = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  const maxCharsPerSecond = speeds.length ? Math.max(...speeds) : 0;
  return { cueCount, avgCharsPerSecond, maxCharsPerSecond };
}

export interface ComputeProductionMetricsInput {
  projectId: string;
  manifestPath: string;
  srtPath?: string;
}

export async function computeProductionMetrics(input: ComputeProductionMetricsInput): Promise<ProductionMetrics> {
  const manifest = JSON.parse(await readFile(input.manifestPath, 'utf8')) as AssembleManifest;
  const rawManifest = JSON.parse(
    await readFile(join(rawDir(input.projectId), 'manifest.json'), 'utf8'),
  ) as RawManifest;

  const totalRawDurationMs = rawManifest.takes.reduce((sum, t) => sum + t.durationMs, 0);
  const usedTakeIds = new Set(manifest.timeline.map((e) => basename(e.source_file, extname(e.source_file))));

  const transcriptCache = new Map<string, { words: TranscriptWord[] }>();
  let wordsUsed = 0;
  let fillerWordsUsed = 0;

  for (const entry of manifest.timeline) {
    const takeId = basename(entry.source_file, extname(entry.source_file));
    let transcript = transcriptCache.get(takeId);
    if (!transcript) {
      transcript = JSON.parse(await readFile(join(transcriptsDir(input.projectId), `${takeId}.json`), 'utf8'));
      transcriptCache.set(takeId, transcript as { words: TranscriptWord[] });
    }
    for (const word of transcript!.words) {
      if (word.startMs >= entry.source_end_ms || word.endMs <= entry.source_start_ms) continue;
      wordsUsed += 1;
      if (FILLER_WORDS.has(normalizeText(word.text))) fillerWordsUsed += 1;
    }
  }

  const metrics: ProductionMetrics = {
    takesAvailable: rawManifest.takes.length,
    takesUsedInFinalCut: usedTakeIds.size,
    totalRawDurationMs,
    finalDurationMs: manifest.durationMs,
    compressionRatio: totalRawDurationMs > 0 ? manifest.durationMs / totalRawDurationMs : 0,
    wordsUsed,
    wordsPerSecond: manifest.durationMs > 0 ? wordsUsed / (manifest.durationMs / 1000) : 0,
    fillerWordRatio: wordsUsed > 0 ? fillerWordsUsed / wordsUsed : 0,
  };

  if (input.srtPath) {
    metrics.subtitleReadingSpeed = evaluateSubtitleReadingSpeed(await readFile(input.srtPath, 'utf8'));
  }

  return metrics;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [projectId, manifestPath, srtPath] = process.argv.slice(2);
  if (!projectId || !manifestPath) {
    console.error('Usage: node --import tsx eval/production-metrics.ts <projectId> <manifest.json> [subtitles.srt]');
    process.exitCode = 1;
  } else {
    computeProductionMetrics({ projectId, manifestPath, ...(srtPath ? { srtPath } : {}) }).then((metrics) => {
      console.log(JSON.stringify(metrics, null, 2));
    });
  }
}
