type AssembleOutput = import('../pipeline/04-assemble.js').AssembleOutput;
type SubtitlesOutput = import('../pipeline/05-subtitles.js').SubtitlesOutput;
type MixOutput = import('../pipeline/07-mix.js').MixOutput;

/**
 * The Director's final answer is free-form text; the actual render paths
 * live inside tool-call results buried in the conversation. Rather than
 * parsing message history after the fact, the assemble/subtitles/mix tools
 * push their results here as they run, so the run-loop can read the latest
 * one directly and deterministically.
 */
export interface RunSink {
  assembleResults: AssembleOutput[];
  subtitleResults: SubtitlesOutput[];
  mixResults: MixOutput[];
}

export function createRunSink(): RunSink {
  return { assembleResults: [], subtitleResults: [], mixResults: [] };
}
