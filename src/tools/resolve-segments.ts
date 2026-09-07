import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { SEGMENT_ID_PATTERN } from '../contracts/editorial-plan.js';
import { resolveSegments } from '../pipeline/04-assemble.js';

const ResolveSegmentsInputSchema = z.object({
  segment_ids: z.array(z.string().regex(SEGMENT_ID_PATTERN)).min(1),
});

export function createResolveSegmentsTool(projectId: string) {
  return tool({
    name: 'resolve_segments',
    description:
      'Resolve semantic segment_ids (sentence_id from inspect_take, or fragment_id from tighten_take) into their ' +
      'exact source file and timestamp range. Read-only preview, renders nothing — use it to sanity-check an edit ' +
      'plan before calling assemble_edit. Fails with a clear error if any id is unknown.',
    inputSchema: ResolveSegmentsInputSchema,
    callback: async ({ segment_ids }) => resolveSegments(projectId, segment_ids),
  });
}
