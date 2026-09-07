import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { RunSink } from '../agents/run-sink.js';
import { SEGMENT_ID_PATTERN } from '../contracts/editorial-plan.js';
import { ingest } from '../pipeline/01-ingest.js';
import { ingestPhotos } from '../pipeline/01b-ingest-photos.js';
import { transcribe } from '../pipeline/02-transcribe.js';
import { derush } from '../pipeline/03-derush.js';
import { tighten } from '../pipeline/03b-tighten.js';
import { generateSubtitles } from '../pipeline/05-subtitles.js';
import { prepareSoundLibrary } from '../pipeline/06-sound-library.js';
import { mix } from '../pipeline/07-mix.js';
import { listVoices, synthesizeNarration } from '../pipeline/08-narrate.js';

/**
 * Wraps the remaining pipeline modules (everything except inspect_take,
 * resolve_segments, and assemble_edit, which get their own files) as
 * Strands tools. Every module keeps doing its own Zod validation and
 * ffmpeg/AWS work unchanged — these wrappers only translate the brief's
 * snake_case tool surface to each module's call signature.
 */

export function createIngestTool(projectId: string) {
  return tool({
    name: 'ingest_sources',
    description:
      'Ingest additional raw video files into this project (copies them, computes a sha256, extracts ffprobe ' +
      'metadata). The initial raw media directory is normally already ingested before you start — use this only if ' +
      'you need to add more sources mid-run.',
    inputSchema: z.object({
      sources: z
        .array(
          z.object({
            path: z.string().min(1),
            take_id: z.string().regex(SEGMENT_ID_PATTERN).optional(),
          }),
        )
        .min(1),
    }),
    callback: async ({ sources }) =>
      ingest({
        projectId,
        sources: sources.map((s) => (s.take_id ? { path: s.path, takeId: s.take_id } : { path: s.path })),
      }),
  });
}

export function createTranscribeTool(projectId: string) {
  return tool({
    name: 'transcribe_take',
    description:
      'Run AWS Transcribe on one ingested take to get word-level timestamps and sentence_ids. Required before ' +
      'inspect_take can show a transcript for that take. Can take a couple of minutes for longer takes.',
    inputSchema: z.object({ take_id: z.string().regex(SEGMENT_ID_PATTERN) }),
    callback: async ({ take_id }) => transcribe({ projectId, takeId: take_id }),
  });
}

export function createDerushTool(projectId: string) {
  return tool({
    name: 'derush_project',
    description:
      'Analyze already-transcribed takes for likely failed material (filler-heavy sentences, explicit restart cues, ' +
      'long trailing dead air) and duplicate sentences across takes. Flags only — never deletes anything or decides ' +
      'for you; use the flags to avoid picking flawed material.',
    inputSchema: z.object({ take_ids: z.array(z.string().regex(SEGMENT_ID_PATTERN)).min(1) }),
    callback: async ({ take_ids }) => derush({ projectId, takeIds: take_ids }),
  });
}

export function createTightenTool(projectId: string) {
  return tool({
    name: 'tighten_take',
    description:
      'Measure and remove dead air from one take using ffmpeg silence detection, with a safety margin so no word is ' +
      'ever cut. Produces fragment_ids you can reference as segment_id in assemble_edit for a version of that take ' +
      'with silences already removed.',
    inputSchema: z.object({
      take_id: z.string().regex(SEGMENT_ID_PATTERN),
      margin_ms: z.number().int().min(0).max(2000).optional(),
    }),
    callback: async ({ take_id, margin_ms }) => tighten({ projectId, takeId: take_id, marginMs: margin_ms }),
  });
}

export function createSubtitlesTool(projectId: string, sink: RunSink) {
  return tool({
    name: 'generate_subtitles',
    description:
      'Generate SRT/VTT subtitles for an assembled render by projecting original word timings onto its timeline. ' +
      'Call this after assemble_edit, passing the manifest_path it returned.',
    inputSchema: z.object({ manifest_path: z.string().min(1) }),
    callback: async ({ manifest_path }) => {
      const result = await generateSubtitles({ project_id: projectId, manifest_path });
      sink.subtitleResults.push(result);
      return result;
    },
  });
}

export function createSoundLibraryTool(projectId: string) {
  return tool({
    name: 'prepare_sound_library',
    description:
      'Prepare a music/SFX asset for mixing. Only files already present in the local sound library (data/sounds/) ' +
      'can be used — this never fetches from the internet — and every request must state a license. If you are not ' +
      'sure a suitable file exists, skip music rather than guessing a filename.',
    inputSchema: z.object({
      requests: z
        .array(
          z.object({
            cue_id: z.string().regex(SEGMENT_ID_PATTERN),
            type: z.enum(['music', 'sfx']),
            filename: z.string().min(1),
            license: z.string().min(1),
          }),
        )
        .min(1),
    }),
    callback: async ({ requests }) => prepareSoundLibrary({ project_id: projectId, requests }),
  });
}

export function createMixTool(projectId: string, sink: RunSink) {
  return tool({
    name: 'mix_final',
    description:
      "Final step: mix the assembled video's voice track with an optional prepared music asset (sidechain ducking " +
      'under speech), normalize loudness, optionally mux subtitles as a soft subtitle track, and render the final ' +
      'video. Only call this after assemble_edit.',
    inputSchema: z.object({
      video_path: z.string().min(1),
      music: z.object({ stored_path: z.string().min(1), volume_db: z.number().optional() }).optional(),
      subtitles_path: z.string().min(1).optional(),
      target_lufs: z.number().optional(),
    }),
    callback: async ({ video_path, music, subtitles_path, target_lufs }) => {
      const result = await mix({ project_id: projectId, video_path, music, subtitles_path, target_lufs });
      sink.mixResults.push(result);
      return result;
    },
  });
}

export function createIngestPhotosTool(projectId: string) {
  return tool({
    name: 'ingest_photos',
    description:
      'Ingest additional still images into this project (copies them, computes a sha256, reads dimensions). ' +
      'Uploaded photos are normally already ingested before you start — use this only to add more mid-run.',
    inputSchema: z.object({
      sources: z
        .array(
          z.object({
            path: z.string().min(1),
            photo_id: z.string().regex(SEGMENT_ID_PATTERN).optional(),
          }),
        )
        .min(1),
    }),
    callback: async ({ sources }) =>
      ingestPhotos({
        projectId,
        sources: sources.map((s) => (s.photo_id ? { path: s.path, photoId: s.photo_id } : { path: s.path })),
      }),
  });
}

export function createListVoicesTool() {
  return tool({
    name: 'list_voices',
    description:
      'List available Amazon Polly voices for a language (default fr-FR), with gender and supported engines ' +
      '(standard/neural/generative). Call this before synthesize_narration if you want to pick a voice deliberately ' +
      '(e.g. matching the tone of the brief) instead of using the default.',
    inputSchema: z.object({ language_code: z.string().min(2).optional() }),
    callback: async ({ language_code }) => listVoices(language_code ? { languageCode: language_code } : {}),
  });
}

export function createNarrateTool(projectId: string) {
  return tool({
    name: 'synthesize_narration',
    description:
      'Turn text YOU write into a real voice-over via Amazon Polly. Use this to generate a hook, a transition, or a ' +
      "CTA that doesn't exist verbatim in any take — e.g. a clear call to action when the raw footage has none. " +
      'Returns a narration_id plus the ACTUAL measured duration and word count — check the duration before locking ' +
      'in your plan, since spoken pacing is not perfectly predictable from text length. Reference the returned ' +
      'narration_id (never the raw text) as a narration segment in assemble_edit. Keep the text grounded in the ' +
      'brief/script/real transcripts — never invent facts, prices, or claims that are not already there.',
    inputSchema: z.object({
      text: z.string().min(1).max(3000),
      voice_id: z.string().min(1).optional().describe('A Polly VoiceId from list_voices. Omit for a sensible French default.'),
      engine: z.enum(['standard', 'neural', 'generative', 'long-form']).optional(),
      language_code: z.string().min(2).optional(),
    }),
    callback: async ({ text, voice_id, engine, language_code }) =>
      synthesizeNarration({
        projectId,
        text,
        ...(voice_id ? { voiceId: voice_id } : {}),
        ...(engine ? { engine } : {}),
        ...(language_code ? { languageCode: language_code } : {}),
      }),
  });
}
