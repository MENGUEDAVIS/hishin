# HISHIN — The Agentic Video Production Desk

Runs locally, no account or login required — clone it, follow
[Installation](#installation) below, and it's ready. A separately hosted,
multi-user deployment of this same core also exists at
https://hishin.globalnavigator.app.

Architecture diagrams (system + the Director/Critic agent loop):
[`ARCHITECTURE.md`](ARCHITECTURE.md). License: [MIT](LICENSE).

« AI decides what to cut. Deterministic tools decide where to cut. »

## Status

All 6 steps of the original brief are implemented: the deterministic media
pipeline (`01-ingest` through `07-mix`), Strands tools, Director/Critic
agents on Amazon Bedrock, an Express server + React UI, scripted agent
tests, and evaluation scripts. Tested under real conditions at every step
(real AWS Transcribe and Bedrock, real videos, a real browser for the UI)
— see `docs/architecture.md` for the detail of every validation.

Post-delivery extension: a **script** field distinct from the brief (the
text the take was meant to say on camera, used as a reference by the
agent), **generated voice-over narration** (Amazon Polly — `08-narrate.js`,
real word-by-word timing via speech marks) for a CTA or transition missing
from the raw footage, and **uploaded photos** usable as segments or as the
visual behind a narration (`01b-ingest-photos.js`, `09-photo-clip.js`, a
slow Ken Burns zoom, an optional burned-in caption). The editorial plan
freely mixes all 3 segment types (`take` / `narration` / `photo`).

See [the architecture, dependencies, and real run results](docs/architecture.md)
and [the JSON contracts of every pipeline module](docs/tool-contracts.md).

```sh
npm run check:setup       # Node 24, FFmpeg/FFprobe, AWS CLI
npm run typecheck         # tsc --noEmit across the repo (JS included via JSDoc)
npm test                  # unit + integration (real ffmpeg, skipped if absent)
npm run test:agents       # scripted models; the narration scenario calls Amazon Polly
node scripts/pipeline.js <module> --file input.json   # run one module in isolation

# Full pipeline on real raw footage (ingest + real AWS Transcribe + derush)
node --env-file=.env scripts/run-project.js <projectId> <file1> <file2> ...

# Director + Critic agents (Amazon Bedrock) looping until PASS or MAX_REVISION_ROUNDS
node --env-file=.env --import tsx scripts/run-director.ts \
  <projectId> "<brief>" <targetDurationSeconds> <mp4|mov> <take_id> [take_id...]

# Evaluate an already-produced render
node --import tsx eval/timing.ts <manifest.json>
node --import tsx eval/production-metrics.ts <projectId> <manifest.json> [subtitles.srt]

# Server + UI (two separate processes; the UI proxies /api to the server)
npm run server    # http://127.0.0.1:3001
npm run ui:dev     # http://localhost:5173
```

## Dashboard and edit history

The UI has a **Dashboard**, **New edit**, and **History**. History lets you
search past renders, filter by verdict, and open any version to watch the
video, review the segments it kept, and read the agents' reasoning. The
assembled cut and the final mix are viewable separately when both exist.
The in-progress form is preserved when switching tabs (not across a page
reload).

`GET /api/library` discovers projects and render manifests already present
under `DATA_DIR/projects`, including ones produced earlier via the CLI.
Older videos stay visible even without an agent review record; missing
information is called out explicitly. Deleted video files are flagged as
unavailable.

New server sessions are saved atomically to `projects/<id>/jobs/<jobId>.json`.
A restart marks any unfinished sessions as errored rather than silently
resuming the agents. Only one job per project can be active on the server
at a time. Each subsequent iteration keeps the Director's decisions and the
Critic's evaluation in the render's `review.json`; previously written
decisions stay accessible even if a later evaluation fails.

```sh
npm run test:history  # older versions, missing files, restart behavior; no AWS needed
npm run ui:build      # build the UI
```

After changing the backend, restart `npm run server`. For an isolated
preview without interrupting an existing server:

```sh
PORT=3002 npm run server
API_PROXY_TARGET=http://127.0.0.1:3002 npm run ui:dev -- --host 127.0.0.1 --port 5174
```

## Installation

Prerequisites: Node.js 24, npm, FFmpeg and FFprobe on the PATH. On macOS
with Homebrew: `brew install ffmpeg`.

```sh
npm ci
cp .env.example .env
npm run check:setup
npm run typecheck
```

`check:setup` doesn't contact AWS and exits non-zero if a required media
tool is missing. `npm test` covers the pipeline (unit + real ffmpeg
integration); `npm run test:agents` covers the agents with a scripted
model — its narration scenario calls real Amazon Polly.

## AWS

The SDK uses the standard AWS credential chain, including CLI profiles.
Region: `us-east-1`. `TRANSCRIBE_S3_BUCKET` points to a dedicated S3
bucket (public access blocked, AES256 encryption, automatic 7-day
expiration under the `hishin/` prefix), and
`BEDROCK_DIRECTOR_MODEL_ID`/`BEDROCK_CRITIC_MODEL_ID` reference Bedrock
inference profiles verified available for this account
(`us.anthropic.claude-sonnet-4-6` and
`us.anthropic.claude-haiku-4-5-20251001-v1:0` — Claude 3.5 didn't appear
in the queried regional catalog). These three values, the
`bedrock-runtime converse` call, and a full Director/Critic run were all
tested with real AWS calls, not just a catalog read.

Renders run locally; Bedrock and AWS Transcribe are called remotely.
Required permissions are limited to the chosen model, Transcribe jobs, and
the project's S3 prefix. AWS credentials stay server-side.
