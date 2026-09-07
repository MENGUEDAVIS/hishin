# Step 1 — Repository structure and dependencies

## Implementation choices

Node.js 24 in ESM; the pipeline is JavaScript with JSDoc checked by
TypeScript; contracts, Strands tools, agents, and the server are
TypeScript; the UI is React + TypeScript with Vite. Local storage uses
`node:sqlite` and per-project JSON files. Node 24's native SQLite remains
an API worth watching across runtime updates.

For a demo, a local server process and a concurrency-limited render queue
are enough. The choice of AWS hosting and its deployment were left open
at this step; no cloud compute service is provisioned here.

FFmpeg and FFprobe run via `node:child_process.spawn`, with argument
arrays, never a shell. `fluent-ffmpeg` is deprecated and its repository
archived: this deviation from the brief avoids building the pipeline on
top of an abandoned wrapper.
Source: https://github.com/fluent-ffmpeg/node-fluent-ffmpeg

Strands TypeScript provides the agents, the Bedrock provider, and Zod
tools.
Source: https://strandsagents.com/docs/user-guide/quickstart/typescript/

## Full target tree

The folders are created now. The business files below are **planned**
and will be written in steps 2 through 6; no placeholder file simulates
their implementation. The config files, this document, and
`scripts/check-setup.js` already exist.

```text
hi-shin/
├── brief.md
├── README.md
├── package.json
├── package-lock.json
├── .gitignore
├── .nvmrc
├── .env.example
├── tsconfig.json
├── jest.config.js
├── docs/
│   ├── architecture.md
│   ├── tool-contracts.md
│   └── demo-runbook.md
├── config/
│   ├── brand.example.json
│   └── pricing.example.json
├── scripts/
│   ├── check-setup.js
│   ├── pipeline.js
│   └── generate-fixtures.js
├── src/
│   ├── pipeline/
│   │   ├── 01-ingest.js
│   │   ├── 02-transcribe.js
│   │   ├── 03-derush.js
│   │   ├── 03b-tighten.js
│   │   ├── 04-assemble.js
│   │   ├── 05-subtitles.js
│   │   ├── 06-sound-library.js
│   │   └── 07-mix.js
│   ├── media/
│   │   ├── ffmpeg.js
│   │   ├── probe.js
│   │   ├── timeline.js
│   │   └── paths.js
│   ├── contracts/
│   │   ├── pipeline.ts
│   │   ├── editorial-plan.ts
│   │   └── critique.ts
│   ├── tools/
│   │   ├── inspect-take.ts
│   │   ├── resolve-segments.ts
│   │   ├── assemble-edit.ts
│   │   ├── pipeline-tools.ts
│   │   └── registry.ts
│   ├── agents/
│   │   ├── director.ts
│   │   ├── critic.ts
│   │   ├── prompts.ts
│   │   └── run-loop.ts
│   ├── state/
│   │   ├── database.ts
│   │   └── project-store.ts
│   ├── observability/
│   │   ├── logger.ts
│   │   ├── traces.ts
│   │   └── usage.ts
│   └── server/
│       ├── index.ts
│       ├── config.ts
│       ├── jobs.ts
│       └── routes.ts
├── ui/
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts
│       ├── styles.css
│       └── components/
│           ├── ProjectForm.tsx
│           ├── RunTrace.tsx
│           └── ReviewPlayer.tsx
├── tests/
│   ├── unit/
│   │   ├── pipeline.test.js
│   │   ├── contracts.test.js
│   │   └── timeline.test.js
│   ├── integration/
│   │   ├── media-workflow.test.js
│   │   ├── agent-tools.test.js
│   │   └── bedrock-live.test.js
│   └── fixtures/
│       ├── transcript.json
│       └── brief.json
├── eval/
│   ├── timing.ts
│   └── production-metrics.ts
└── data/                         # git-ignored except .gitkeep
    ├── sounds/
    └── projects/<project_id>/
        ├── project.json
        ├── state.sqlite
        ├── raw/
        ├── transcripts/
        ├── plans/
        ├── renders/
        └── traces/events.jsonl
```

## npm dependencies

Constraints live in `package.json`; resolved versions are locked in
`package-lock.json` for `npm ci`.

| Package | Planned use |
| --- | --- |
| `@strands-agents/sdk` | Director, Critic, tools, and the agent loop |
| `@aws-sdk/client-bedrock-runtime` | Types, commands, and Bedrock runtime access |
| `@aws-sdk/client-s3` | Intermediate audio and Transcribe results |
| `@aws-sdk/client-transcribe` | Transcription jobs with word timestamps |
| `zod` | Strict validation of inputs, plans, outputs, and configs |
| `express` | Local API, projects, renders, progress streams |
| `pino` | Structured JSON logs |
| `react`, `react-dom` | Creation and review interface |
| `typescript`, `tsx` | Type checking and running TypeScript |
| `vite` | UI development and build |
| `jest`, `@types/jest` | Unit and integration tests |
| `@types/node`, `@types/express` | Server types |
| `@types/react`, `@types/react-dom` | UI types |

No extra SQLite, dotenv, UUID, SRT, or FFmpeg-wrapper package is needed:
Node provides SQLite, `--env-file`, `crypto.randomUUID`, and child
processes; SRT/VTT are serialized by tested functions. AWS Transcribe is
the chosen initial provider, so Whisper isn't required.

## Planned contracts and responsibilities

Each module exposes an async JSON → JSON function and is reachable
through a common CLI. JSON output goes to stdout, diagnostics to stderr.
Zod validates inputs before any media access.

1. **Ingest**: validation, copying sources, hashes, FFprobe metadata,
   stable IDs.
2. **Transcribe**: FFmpeg audio extraction, S3, an AWS Transcribe job,
   timestamped words, sentences, and IDs. Boundaries come from the
   transcriber's own alignment, never from an LLM — these are recognition
   estimates, not sample-exact ground truth.
3. **Derush**: heuristics for duplicates/failed takes, explainable scores
   and flags; the Director decides editorial relevance, no automatic
   removal of sources.
4. **Tighten**: silences measured by FFmpeg, conservative margins around
   words, derived fragments persisted with IDs. No agent-generated time
   boundary.
5. **Assemble**: resolves IDs from storage, normalizes video/audio, cuts
   and concatenates with re-encoding, a source → output mapping manifest.
6. **Subtitles**: projects words onto the actually assembled timeline,
   SRT/VTT.
7. **Sound library**: local sounds or explicitly configured URLs,
   validation, FFmpeg prep, license metadata; no music is assumed
   royalty-free.
8. **Mix**: music, ducking, loudness, final render, and FFprobe
   measurement.

`inspect_take(take_id)` returns the brief's contract, timestamps included
for inspection purposes. The strict editorial plan accepts only IDs,
roles, and reasons: extra timing fields are rejected, as are unknown IDs.
`resolve_segments(segment_ids)` resolves boundaries from persisted data.
`assemble_edit(edit_plan)` resolves segments itself: no timestamp pair
supplied by an agent is ever an editorial authority.

The Director composes the plan, the tools produce the render, then the
Critic returns PASS/REVISE plus structured issues. Duration and technical
characteristics are checked by code. Coherence, CTA, and brand are
evaluated from the brief, the text actually kept, and frames extracted
from the render, within the limits of what the model can judge. The
number of revisions is bounded and every attempt is kept.

## Planned state, observability, and verification

SQLite stores projects, jobs, segments, plans, renders, and statuses.
JSON keeps human-readable artifacts; transitions are persisted so an
interruption can be diagnosed. Every trace includes project, run, tool,
duration, status, and model usage. Costs are estimates computed from
configured, dated rates; a missing rate means an unknown cost. Transcribe,
S3, and compute costs are kept distinct from token costs.

Media tests use FFmpeg-generated synthetic files, with assertions on
durations, timebase changes, subtitles, and cuts. Agent tests inject a
controlled model to prove tool calls and the rejection of invented
timestamps. Real AWS tests are separate and explicitly opt-in; mocks are
never treated as proof that Bedrock actually works.

## Step 1 validation

`npm run typecheck` verifies the scaffolding present so far, not future
business code. `npm run check:setup` reports missing executables. No
end-to-end video workflow can be claimed yet at this step.

The stop before step 2 comes explicitly from the last section of the
brief: "Wait for my approval before proceeding to STEP 2."

## Step 2 — Deterministic media pipeline (implemented)

The eight modules in `src/pipeline/` (01-ingest through 07-mix) and the
`src/media/` utilities (`ffmpeg.js`, `probe.js`, `timeline.js`,
`paths.js`) are written and working. The JSON contract details for each
module live in [`docs/tool-contracts.md`](tool-contracts.md) instead of
being duplicated here.

Deliberate deviations from the brief, all documented in the code or
above:
- AWS Transcribe (not Whisper), already decided in step 1.
- 04-assemble resolves `segment_id` (sentence_id or fragment_id) itself
  instead of exposing `resolve_segments` as a separate module; the
  `resolveSegments` function is still exported separately for the future
  Strands tool.
- Cuts always re-encode (`-ss`/`-t` after `-i`, never input stream-copy)
  to guarantee frame accuracy, at the cost of speed — acceptable for
  short-form output.

### Step 2 validation

- `npm run typecheck`: no errors, including the pipeline's `.js` files
  (JSDoc checked in `strict` mode).
- `npm run test:unit`: 25 tests — pure functions from `timeline.js`, AWS
  Transcribe parsing against a static fixture, Zod validation for all
  eight modules.
- `npm run test:integration`: 4 tests against a **real** FFmpeg (installed
  and verified via `npm run check:setup`) — generates a synthetic clip
  (`scripts/generate-fixtures.js`), ingests it, measures and removes its
  silences, resolves a `sentence_id` and a `fragment_id` in the same edit
  plan, cuts/concatenates, then projects subtitles onto the produced
  timeline. Assertions are on durations measured by ffprobe, never
  estimated.
- 29 tests total, all green.

Not covered by local tests, by construction: 02-transcribe (needs real
AWS credentials and an S3 bucket — the pure parsing logic is tested
separately via `itemsToWords`) and 07-mix (needs sound-library audio
assets). Both are covered in step 6 with AWS credentials and assets
explicitly enabled, as planned above.

## Step 3 — Strands tools (implemented)

Every pipeline module is now exposed as an `@strands-agents/sdk` tool
(strict Zod, validated before any FFmpeg/AWS call):

- `src/contracts/editorial-plan.ts`: the brief's editorial plan. No
  timestamp field — an agent physically cannot supply one.
- `src/contracts/critique.ts`: the Critic's structured contract.
- `src/tools/inspect-take.ts`, `resolve-segments.ts`, `assemble-edit.ts`:
  the brief's three named contracts.
- `src/tools/pipeline-tools.ts`: `ingest_sources`, `transcribe_take`,
  `derush_project`, `tighten_take`, `generate_subtitles`,
  `prepare_sound_library`, `mix_final` — the rest of the pipeline.
- `src/tools/registry.ts`: `createDirectorTools(projectId, sink)` groups
  the ten tools, bound to a single project via closure (no `project_id`
  ever exposed to the agent).
- `src/agents/run-sink.ts`: `assemble_edit`/`generate_subtitles`/`mix_final`
  push their result into a shared `RunSink` instead of forcing a parse of
  the message history to find the produced render.

Deliberate deviation from the tree planned in step 1:
`src/contracts/pipeline.ts` was not created as a separate file — each
tool declares its own Zod schema, which turned out to be sufficient and
more direct.

## Step 4 — Director and Critic agents (implemented)

`src/agents/director.ts` builds a Bedrock `Agent` (verified-available
model: `us.anthropic.claude-sonnet-4-6`) with the ten tools and a system
prompt (`src/agents/prompts.ts`) that repeats the brief's strict rule.
The tool/model loop is the Strands SDK's own; `run-loop.ts` only adds the
**outer** Director ↔ Critic loop.

`src/agents/critic.ts` builds a second `Agent` (model
`us.anthropic.claude-haiku-4-5-20251001-v1:0`), with no tools, using
`structuredOutputSchema: CritiqueSchema`. It receives the brief, the
target duration, the actual duration measured by ffprobe (never
recomputed by the model), the subtitle text, and three frames extracted
from the render (`extractFrame`, `media/ffmpeg.js`) to judge visual
coherence — as originally planned in step 1.

`src/agents/run-loop.ts` (`orchestrate`) chains Director → Critic,
forwards `issues` as text feedback to the next round on `REVISE`, and
stops after `MAX_REVISION_ROUNDS` revisions (bounded, as planned).
`src/state/project-store.ts` (`node:sqlite`) and
`src/observability/traces.ts`/`usage.ts` record every round (role,
verdict, tokens, cost if a rate is configured, otherwise `null`).

`scripts/run-director.ts` runs a full round from the CLI:
```sh
node --env-file=.env --import tsx scripts/run-director.ts \
  <projectId> "<brief>" <targetDurationSeconds> <mp4|mov> <take_id> [take_id...]
```

### Step 4 validation — a real run, not a simulation

Tested under real conditions on three supplied raw takes (`prise1/2/3.mov`,
26–42s each, in French) after real ingest + AWS Transcribe: the Director
inspected all three takes, ran `derush_project` and `tighten_take` in
parallel, built a first cut (32.8s), and responded to two real critiques
from the Critic (insufficient duration, no explicit CTA) by revising
twice in a row — reasoning about the real duration of sentences at every
iteration. After the maximum number of revisions
(`MAX_REVISION_ROUNDS=2`, so 3 rounds), the final verdict stayed
`REVISE`: neither the target duration nor an explicit verbal CTA actually
existed in the supplied footage, and the Critic reported that honestly
instead of forcing a `PASS`. That's the intended behavior — the system
doesn't claim more than the raw material actually allows.

This run uncovered a real bug in `07-mix.js`: `-af`/`-filter_complex`
were inserted between the video's `-i` and the subtitles' `-i`, which
FFmpeg refuses (output options must follow every input). `mix_final`
therefore failed silently whenever a `subtitles_path` was supplied; the
agent detected it on its own and delivered without muxed subtitles.
Fixed by separating `inputArgs`/`outputArgs`, with a regression test in
`tests/integration/media-workflow.test.js` (music + ducking + subtitles
in the same render).

## Step 6 — Agent tests and evaluation (implemented)

`runDirector`/`runCritic` now accept an optional `model` (a Strands SDK
`Model`): omitted, they build the real `BedrockModel`; supplied, they use
it as-is. That's what makes the agents testable with no network and no
AWS credentials.

`tests/helpers/scripted-model.ts` implements a minimal scripted `Model`:
each `stream()` call consumes the next turn of a script (tool calls or a
final text response), emitting the real streaming events the SDK
expects. Verified directly against the SDK before the tests were
written: tool-call sequencing, propagation of a tool error
(`status: 'error'`), and structured output (the SDK materializes
`structuredOutputSchema` as an internal `strands_structured_output` tool
— observed on step 4's real run before being reproduced here).

`tests/integration/agent-tools.spec.ts` — **deliberately outside
Jest**, run via `npm run test:agents`
(`node --env-file=.env --import tsx tests/integration/agent-tools.spec.ts`)
with `node:assert/strict` assertions. Jest didn't work here: its module
resolver (jest-resolve) builds its own dependency graph before execution
and doesn't follow `tsx`'s extension mapping (a `./x.js` import resolved
to `./x.ts`) — a systematic `Cannot find module` the moment one `.ts`
file imports another. Working around that resolver (a ts-jest transform,
`moduleNameMapper`) would have added a lot of fragility for a small
gain; a standalone `tsx` script, already proven for every CLI script in
this repo, is simpler and just as automated.

Three proofs, no AWS and no token cost:
1. The Director really chains `inspect_take` then `assemble_edit` (on a
   synthetic take actually ingested/tightened) and produces a real file
   — verified via the scripted model's message history, not just the
   final state.
2. **The strict rule holds under adversarial pressure**: a `segment_id`
   fabricated out of thin air fails the tool call
   (`Unable to resolve segment_id`) and produces no render.
3. The Critic runs a real frame extraction on a real render and returns
   the scripted verdict.

`eval/timing.ts` (`evaluateTimingFromManifest`) compares the target
duration to the measured duration and computes each segment's drift
between the requested cut and the actually rendered cut (bounded to
11ms on step 4's real run — ffmpeg's cutting precision, not an
estimate). `eval/production-metrics.ts` (`computeProductionMetrics`)
computes the compression ratio, speech rate (words/second), the share of
filler words kept in the final cut, and subtitle reading speed
(characters/second per cue). Both are also CLIs:
```sh
node --import tsx eval/timing.ts <manifest.json>
node --import tsx eval/production-metrics.ts <projectId> <manifest.json> [subtitles.srt]
```

## Step 5 — Interface and observability (implemented)

`src/server/` (Express): `routes.ts` exposes a thin REST API that
delegates entirely to the existing pipeline/agents (no duplicated logic)
— project creation (`POST /api/projects` → `ingest`), starting a run
(`POST /api/projects/:id/runs` → `orchestrate`, run as a background task
via `jobs.ts` since a real run takes several minutes), status
(`GET .../runs/:jobId`), traces (`GET .../traces`), costs
(`GET .../costs` → `listRuns` in SQLite), and a `GET /api/media?path=...`
endpoint that serves a file **only** if it stays under `DATA_DIR`
(checked via `path.relative`, tested against a path-traversal attempt).

`ui/` (React + Vite + TypeScript, proxies `/api` to the server in dev):
`ProjectForm` (ingestion + run configuration), `RunTrace` (live status
and traces, 3s polling), `ReviewPlayer` (final-render video player, round
history with the Critic's verdicts/issues, a cost table).

### Post-delivery fix — real file upload

The UI's first pass had users type a server-side path into a text field
instead of a real upload — user feedback flagged it as unusable.
`POST /api/projects/upload` (multer, `multipart/form-data`, up to
5GB/file) now accepts real files from the browser, written to a
temporary staging directory then ingested via `ingest()` (staging is
deleted right after, since `ingest()` has already copied each file into
`data/projects/<id>/raw/`). `ProjectForm.tsx` was redesigned as one
continuous flow (brief/script + drag-and-drop zone + upload progress bar
via `XMLHttpRequest`, since `fetch` doesn't expose a reliable progress
event) instead of two panels that appear/disappear.

Bug found during real-browser verification (not just curl): multer's
default disk storage drops the original file extension, so `ingest()`
— which derives the extension from the stored file via
`extname(source.path)` — was writing `take_01` with no extension. Fixed
with a `multer.diskStorage` that preserves the original extension;
re-verified in the browser (`take_01.mov`, correct after the fix).

### Step 5 validation — tested in a real browser, not just curl

`npm run server` then `npm run ui:dev`; tested with `agent-browser` (not
just `curl`, per the real-UI-testing requirement): form filled in,
project actually ingested (real ffprobe on `prise1.mov`), the "Start an
edit" section shown with the detected take, no console errors. The error
path was also verified: a nonexistent file path surfaces the backend's
exact error message (`Source file not found: ...`) all the way to the
UI. Actually starting a Director/Critic run from the UI was not
triggered in this test (real AWS cost/time) — the server→agent path is
already proven separately by step 4's CLI run and by
`tests/integration/agent-tools.spec.ts`.

`tsconfig.json` had to gain `allowImportingTsExtensions: true` so the
same tsconfig could cover both Node imports (`NodeNext`, a `.js`
extension even for a `.ts` source file) and React/Vite imports (explicit
`.tsx`/`.ts` extension) without duplicating the config.

### What isn't done

No access control on the server (local MVP, listens on `127.0.0.1` by
default); no automated tests for the API/UI themselves (only the manual
browser verification above exists). Starting a run from the UI wasn't
tested under real conditions (AWS cost), only its wiring.

## Post-delivery extension — script, generated voice-over, photos

User feedback after step 5: the "brief" (creative intent) wasn't enough
to match the edit to what was actually meant to be said during filming,
and the pipeline could only produce a cut from real raw footage — no
generated voice-over, no photos. Three additions, chosen together with
the user (Polly voice left to the agent's judgment based on context;
photos uploaded into the same drop zone as videos; everything built in a
single pass):

1. **Script vs. brief** — two fields now kept distinct everywhere
   (contracts, agents, UI). The brief is the creative intent; the script
   is the text that was *meant* to be said during filming — a reference,
   not ground truth, since real takes can deviate from it. The Director
   uses it to judge which take best matches the intent and to spot gaps
   the raw footage never covers.

2. **Generated voice-over (Amazon Polly)** — `src/pipeline/08-narrate.js`
   (`synthesizeNarration`, `listVoices`). The agent writes the text; Polly
   speaks it; duration and word-by-word timing come from Polly's *speech
   marks* (measured, never estimated — verified with a real call before
   writing the code: `SynthesizeSpeechCommand` with
   `SpeechMarkTypes:['word']`). The Director must call
   `synthesize_narration` and reference the returned `narration_id` in
   its plan — never the raw text — exactly like a `segment_id` must
   already exist in a transcript. This is the direct answer to the
   problem observed in step 4 (no verbal CTA in the real footage): the
   Director can now generate the missing call-to-action line, grounded
   in the real brief/script/transcripts — never invented facts.

3. **Photos and free-form editing** — `src/pipeline/01b-ingest-photos.js`
   (upload, same endpoint as videos, routed by mimetype/extension) and
   `src/pipeline/09-photo-clip.js` (photo → normalized video clip, a slow
   Ken Burns zoom, optional burned-in caption). `EditorialSegmentSchema`
   (`src/contracts/editorial-plan.ts`) became a discriminated union on
   `kind`: `"take"` (unchanged), `"narration"` (narration_id + optional
   photo_id as the visual), `"photo"` (photo_id + agent-chosen
   `duration_seconds`, capped at 10s — a pacing choice, not a footage
   measurement). `04-assemble.js` was rewritten to build one normalized
   clip per segment regardless of its type, then concatenate as before;
   `05-subtitles.js` now also projects narration words (Polly timing
   local to the segment) and skips silent photos (their caption is
   already burned into the video).

   Two real problems found and fixed while testing with real ffmpeg,
   before writing the final code:
   - A `zoompan` expression containing a comma backslash-escaped INSIDE
     single quotes gave a silently wrong output in ffmpeg (default
     1280×720 resolution instead of the target) — single quotes alone
     are enough, the extra escaping breaks the expression.
   - The standard Homebrew `ffmpeg` build has no `drawtext` (no
     libfreetype); `ffmpeg-full` (bottled, keg-only) does. `.env` points
     `FFMPEG_PATH`/`FFPROBE_PATH` at its binaries. Separately, `drawtext`
     ignores colon-escaping even inside single quotes on this build —
     `escapeDrawtextValue` (`src/media/ffmpeg.js`) neutralizes `:`, `%`,
     `\` instead of escaping them, and replaces a straight apostrophe
     with a typographic one.

Validated with real calls: Polly (`describe-voices`, real synthesis with
speech marks), a mixed take + narration + photo plan assembled and
rendered via `04-assemble.js` directly and then via the real Strands
tool wrapper (`tests/integration/agent-tools.spec.ts`, a dedicated test
— the only part of that file that calls a real AWS service, Polly, for a
cost on the order of a cent), and a mixed video+photo upload tested in a
real browser (files listed separately, project showing "N take(s), M
photo(s)", no console errors).

Not done: the `scripts/run-director.ts` CLI wasn't extended to accept
`script`/photos as arguments (only the UI and API allow it); no dynamic
font-size control for burned-in subtitles based on text length (a very
long caption can overflow the frame).
