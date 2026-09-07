# Step 2 — Deterministic media pipeline contracts

Every module in `src/pipeline/` exports an async JSON → JSON function and
stays callable in isolation, without an agent, via `scripts/pipeline.js`:

```sh
node scripts/pipeline.js <module> --file input.json
echo '{"...")}' | node scripts/pipeline.js <module>
```

JSON output goes to stdout, errors (stack included) to stderr with a
non-zero exit code. Identifiers (`projectId`, `takeId`, `segment_id`,
sound-library filenames) are validated by a conservative regex before any
disk access, to prevent path traversal.

Two casing conventions coexist deliberately: modules 01 through 03b use
`camelCase` keys (internal pipeline state); modules 04 and 05, which
directly implement the brief's tool contracts (`resolve_segments`,
`assemble_edit`), and modules 06/07 use the brief's `snake_case` keys to
stay faithful to the contract exposed later to the Director agent.

## 01-ingest

Copies source files, computes a sha256, and queries ffprobe. Never writes
an invented timestamp — only what ffprobe reports.

```json
// input
{ "projectId": "proj_demo", "sources": [{ "path": "/abs/take1.mov", "takeId": "take_01" }] }
// output
{ "projectId": "proj_demo", "takes": [{ "takeId": "take_01", "sourcePath": "...", "storedPath": "...", "sha256": "...", "durationMs": 12345, "mediaMetadata": { "...": "..." } }], "warnings": [] }
```

Also writes `data/projects/<id>/raw/manifest.json`, read back by every
downstream module to resolve a `storedPath` from a `takeId`.

## 02-transcribe

Extracts audio as mono 16kHz WAV (ffmpeg), sends it to AWS Transcribe,
then splits sentences by punctuation/silence — never by a language
model. Accepts injected AWS clients (`deps.s3Client`,
`deps.transcribeClient`, `deps.fetchImpl`) to stay testable without
network access; `itemsToWords` is exported separately and covered by
`tests/unit/transcribe-parsing.test.js` against a static fixture.

```json
// input
{ "projectId": "proj_demo", "takeId": "take_01", "languageCode": "fr-FR" }
// output
{ "projectId": "...", "takeId": "...", "transcriptPath": "...", "words": [...], "sentences": [...], "warnings": [] }
```

Requires `TRANSCRIBE_S3_BUCKET` and real AWS credentials, so it isn't
covered by local integration tests (see `docs/architecture.md`).

## 03-derush

Flags, without ever deleting a source, takes that are probably failed or
duplicated: filler-word ratio, trailing silence measured by ffmpeg, an
explicit restart phrase, Jaccard similarity between sentences.

```json
// input
{ "projectId": "proj_demo", "takeIds": ["take_01", "take_02"] }
// output
{ "projectId": "...", "flags": [{ "takeId": "...", "sentenceId": "...", "flagType": "filler_heavy", "score": 0.2, "explanation": "..." }], "duplicateGroups": [{ "groupId": "dup_01", "members": [...], "similarity": 0.86 }] }
```

## 03b-tighten

Measures silences (`ffmpeg silencedetect`), shrinks them by a
configurable margin so a word is never cut, then computes the remaining
fragments. Persists `data/projects/<id>/tighten/<takeId>.json`.

```json
// input
{ "projectId": "proj_demo", "takeId": "take_01", "marginMs": 120, "minSilenceToCutMs": 500 }
// output
{ "projectId": "...", "takeId": "...", "originalDurationMs": 4300, "tightDurationMs": 3200, "removedMs": 1100, "fragments": [{ "fragmentId": "take_01_f01", "startMs": 0, "endMs": 1620, "includesSentenceIds": ["take_01_s01"] }] }
```

## 04-assemble (`assemble_edit` + `resolve_segments`)

The only place in the pipeline where a semantic `segment_id` becomes a
timestamp. `resolveSegments` accepts a `sentence_id` (from 02-transcribe)
or a `fragment_id` (from 03b-tighten), looks up the source file and its
original boundaries, and throws an explicit error if the identifier is
unknown — so no agent can ever supply a timestamp that would carry any
authority. `assemble` resolves, cuts (precise re-encoding, `-ss`/`-t`
after `-i`), normalizes (resolution/fps configurable via `brand_config`),
and concatenates.

```json
// input
{
  "project_id": "proj_demo",
  "edit_plan": {
    "target_duration_seconds": 60,
    "output_format": "mp4",
    "segments": [
      { "segment_id": "take_01_s01", "role": "hook", "reason": "opening hook" },
      { "segment_id": "take_04_f02", "role": "body", "reason": "core message" }
    ]
  }
}
// output
{ "output_path": "...", "duration_ms": 61200, "segments_used": ["take_01_s01", "take_04_f02"], "warnings": [], "manifest_path": "...", "timeline": [{ "segment_id": "...", "source_file": "...", "source_start_ms": 0, "source_end_ms": 1500, "output_start_ms": 0, "output_end_ms": 1480 }] }
```

`manifest_path` points to a complete JSON file (plan, timeline, warnings)
consumed by 05-subtitles.

## 05-subtitles

Projects the source transcripts' words onto the timeline actually
produced by assembly (`output_start_ms - source_start_ms` offset), groups
them into readable cues (character/duration/silence limits), writes SRT
and VTT.

```json
// input
{ "project_id": "proj_demo", "manifest_path": "data/projects/proj_demo/renders/assemble_.../manifest.json" }
// output
{ "srt_path": "...", "vtt_path": "...", "cue_count": 14 }
```

## 06-sound-library

Only prepares files already present under `data/sounds/` (no arbitrary
network fetch) and requires an explicit license per request — never
assumed royalty-free.

```json
// input
{ "project_id": "proj_demo", "requests": [{ "cue_id": "music_bed", "type": "music", "filename": "corporate-loop.mp3", "license": "CC-BY 4.0 — Author X" }] }
// output
{ "project_id": "...", "assets": [{ "cue_id": "music_bed", "type": "music", "stored_path": "...", "duration_ms": 90000, "license": "..." }], "warnings": [] }
```

## 07-mix

Mixes voice + music (ducking via `sidechaincompress`), normalizes
loudness (`loudnorm`), measures the final result with a separate ffmpeg
analysis pass, and optionally muxes subtitles as a soft track
(`mov_text`).

```json
// input
{ "project_id": "proj_demo", "video_path": ".../assembled.mp4", "music": { "stored_path": "...", "volume_db": -18 }, "subtitles_path": ".../assemble_....srt", "target_lufs": -14 }
// output
{ "output_path": "...", "duration_ms": 61200, "loudness_measured": { "integrated_lufs": -14.1, "true_peak_dbtp": -1.6, "loudness_range": 6.2 }, "warnings": [] }
```

## Current test coverage

- `tests/unit/timeline.test.js`: pure functions from
  `src/media/timeline.js`.
- `tests/unit/transcribe-parsing.test.js`: AWS Transcribe parsing against
  a static fixture (`tests/fixtures/transcript.json`), no network.
- `tests/unit/pipeline.test.js`: Zod validation and error paths, no
  ffmpeg.
- `tests/integration/media-workflow.test.js`: a real run (ffmpeg
  generates a synthetic clip in memory) through
  ingest → tighten → assemble → subtitles, with assertions on durations
  measured by ffprobe. Automatically skipped if ffmpeg is missing from
  the PATH.

02-transcribe (AWS) and 07-mix (real audio assets) aren't yet covered by
a local integration test; that's handled in step 6 with AWS credentials
explicitly enabled, as described in `docs/architecture.md`.
