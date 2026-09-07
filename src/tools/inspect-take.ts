import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { SEGMENT_ID_PATTERN } from '../contracts/editorial-plan.js';
import { derushDir, rawDir, tightenDir, transcriptsDir } from '../media/paths.js';

/**
 * inspect_take — the brief's read-only contract, plus additive fields
 * (fragment_ids, flags) so the Director doesn't need a separate tool call
 * per take just to see what's already been tightened or flagged.
 */

const InspectTakeInputSchema = z.object({
  take_id: z.string().regex(SEGMENT_ID_PATTERN),
});

interface RawManifestTake {
  takeId: string;
  durationMs: number;
  mediaMetadata: unknown;
}

export function createInspectTakeTool(projectId: string) {
  return tool({
    name: 'inspect_take',
    description:
      'Inspect one ingested take: its transcript (sentence_id, text, start_ms, end_ms), duration, media metadata, ' +
      'any fragment_ids already produced by tighten_take, and any derush flags for it. Read-only — call this before ' +
      'deciding which segments to use.',
    inputSchema: InspectTakeInputSchema,
    callback: async ({ take_id }) => {
      const manifest = JSON.parse(await readFile(join(rawDir(projectId), 'manifest.json'), 'utf8')) as {
        takes: RawManifestTake[];
      };
      const take = manifest.takes.find((t) => t.takeId === take_id);
      if (!take) {
        throw new Error(
          `Unknown take_id: ${take_id}. Ingested takes: ${manifest.takes.map((t) => t.takeId).join(', ')}`,
        );
      }

      const transcript = await readFile(join(transcriptsDir(projectId), `${take_id}.json`), 'utf8')
        .then((raw) => JSON.parse(raw) as { sentences: { sentenceId: string; text: string; startMs: number; endMs: number }[] })
        .catch(() => null);

      const tightenRecord = await readFile(join(tightenDir(projectId), `${take_id}.json`), 'utf8')
        .then((raw) => JSON.parse(raw) as { fragments: { fragmentId: string }[] })
        .catch(() => null);

      const derushReport = await readFile(join(derushDir(projectId), 'report.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as { flags: { takeId: string }[] })
        .catch(() => null);

      return {
        take_id,
        transcript: transcript
          ? transcript.sentences.map((s) => ({
              sentence_id: s.sentenceId,
              text: s.text,
              start_ms: s.startMs,
              end_ms: s.endMs,
            }))
          : [],
        sentence_ids: transcript ? transcript.sentences.map((s) => s.sentenceId) : [],
        fragment_ids: tightenRecord ? tightenRecord.fragments.map((f) => f.fragmentId) : [],
        duration_ms: take.durationMs,
        media_metadata: take.mediaMetadata,
        transcribed: Boolean(transcript),
        tightened: Boolean(tightenRecord),
        flags: derushReport ? derushReport.flags.filter((f) => f.takeId === take_id) : [],
      };
    },
  });
}
