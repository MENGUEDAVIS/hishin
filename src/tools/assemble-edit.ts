import { tool } from '@strands-agents/sdk';
import type { RunSink } from '../agents/run-sink.js';
import { EditorialPlanSchema } from '../contracts/editorial-plan.js';
import { assemble } from '../pipeline/04-assemble.js';

export function createAssembleEditTool(projectId: string, sink: RunSink) {
  return tool({
    name: 'assemble_edit',
    description:
      'The ONLY way to turn an editorial plan into an actual rendered video. Give it segment_id + role + reason for ' +
      'each segment, in final playback order — hook first, then body, then cta. Never provide a timestamp: this ' +
      'tool resolves every segment_id itself against the real transcript/tighten data, cuts with ffmpeg, and ' +
      'concatenates. Call it exactly once with your final plan.',
    inputSchema: EditorialPlanSchema,
    callback: async (editPlan) => {
      const result = await assemble({ project_id: projectId, edit_plan: editPlan });
      sink.assembleResults.push(result);
      return result;
    },
  });
}
