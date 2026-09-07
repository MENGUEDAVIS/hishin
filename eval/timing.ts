import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Timing-accuracy evaluation: how closely the render matched the requested
 * target duration, and how much each individual cut drifted from the exact
 * range resolve_segments handed to ffmpeg. All numbers here come from the
 * assemble manifest — itself built from ffprobe measurement, never a guess.
 */

interface TimelineEntry {
  segment_id: string;
  source_start_ms: number;
  source_end_ms: number;
  output_start_ms: number;
  output_end_ms: number;
}

interface AssembleManifest {
  editPlan?: { target_duration_seconds?: number };
  timeline: TimelineEntry[];
  durationMs: number;
}

export interface SegmentDrift {
  segment_id: string;
  requestedMs: number;
  renderedMs: number;
  driftMs: number;
}

export interface TimingReport {
  actualDurationMs: number;
  targetDurationSeconds?: number;
  deltaMs?: number;
  deltaPercent?: number;
  withinTolerance?: boolean;
  segments: SegmentDrift[];
  maxSegmentDriftMs: number;
}

/**
 * @param timeline The assemble manifest's timeline (source + output ranges per segment).
 * @param actualDurationMs The ffprobe-measured duration of the final render.
 * @param targetDurationSeconds The brief's requested duration, if any.
 * @param toleranceSeconds Acceptable absolute deviation from target. Defaults to 2s.
 */
export function evaluateTiming(
  timeline: TimelineEntry[],
  actualDurationMs: number,
  targetDurationSeconds?: number,
  toleranceSeconds = 2,
): TimingReport {
  const segments: SegmentDrift[] = timeline.map((entry) => {
    const requestedMs = entry.source_end_ms - entry.source_start_ms;
    const renderedMs = entry.output_end_ms - entry.output_start_ms;
    return { segment_id: entry.segment_id, requestedMs, renderedMs, driftMs: renderedMs - requestedMs };
  });
  const maxSegmentDriftMs = segments.reduce((max, s) => Math.max(max, Math.abs(s.driftMs)), 0);

  const report: TimingReport = { actualDurationMs, segments, maxSegmentDriftMs };
  if (targetDurationSeconds) {
    const targetMs = targetDurationSeconds * 1000;
    const deltaMs = actualDurationMs - targetMs;
    report.targetDurationSeconds = targetDurationSeconds;
    report.deltaMs = deltaMs;
    report.deltaPercent = (deltaMs / targetMs) * 100;
    report.withinTolerance = Math.abs(deltaMs) <= toleranceSeconds * 1000;
  }
  return report;
}

/**
 * Loads an assemble manifest.json and evaluates its timing accuracy.
 * @param manifestPath Path to renders/<renderId>/manifest.json
 * @param toleranceSeconds Acceptable absolute deviation from target. Defaults to 2s.
 */
export async function evaluateTimingFromManifest(manifestPath: string, toleranceSeconds = 2): Promise<TimingReport> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AssembleManifest;
  return evaluateTiming(manifest.timeline, manifest.durationMs, manifest.editPlan?.target_duration_seconds, toleranceSeconds);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('Usage: node --import tsx eval/timing.ts <manifest.json>');
    process.exitCode = 1;
  } else {
    evaluateTimingFromManifest(manifestPath).then((report) => {
      console.log(JSON.stringify(report, null, 2));
    });
  }
}
