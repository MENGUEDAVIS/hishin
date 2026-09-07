import type { ToolList } from '@strands-agents/sdk';
import type { RunSink } from '../agents/run-sink.js';
import { createAssembleEditTool } from './assemble-edit.js';
import { createInspectTakeTool } from './inspect-take.js';
import {
  createDerushTool,
  createIngestPhotosTool,
  createIngestTool,
  createListVoicesTool,
  createMixTool,
  createNarrateTool,
  createSoundLibraryTool,
  createSubtitlesTool,
  createTightenTool,
  createTranscribeTool,
} from './pipeline-tools.js';
import { createResolveSegmentsTool } from './resolve-segments.js';

/**
 * The full pipeline, wrapped as Strands tools and bound to one project.
 * Every module from 01-ingest to 09-photo-clip is represented (photo-clip
 * itself is invoked internally by assemble_edit, not exposed directly),
 * plus the read-only helpers the brief calls out by name.
 *
 * Narration (list_voices/synthesize_narration) is opt-in per run: without an
 * explicit human allowNarration=true, those tools are withheld entirely so
 * the Director cannot decide on its own to add a generated voice-over.
 */
export function createDirectorTools(projectId: string, sink: RunSink, opts: { allowNarration?: boolean } = {}): ToolList {
  return [
    ...(process.env.NODE_ENV === 'production' ? [] : [createIngestTool(projectId), createIngestPhotosTool(projectId)]),
    createTranscribeTool(projectId),
    createDerushTool(projectId),
    createTightenTool(projectId),
    createInspectTakeTool(projectId),
    createResolveSegmentsTool(projectId),
    ...(opts.allowNarration ? [createListVoicesTool(), createNarrateTool(projectId)] : []),
    createAssembleEditTool(projectId, sink),
    createSubtitlesTool(projectId, sink),
    createSoundLibraryTool(projectId),
    createMixTool(projectId, sink),
  ];
}
