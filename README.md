# HISHIN — The Agentic Video Production Desk

**AI decides what to cut. Deterministic tools decide where to cut.**

## What this is

You record several takes for a short video — some stronger than others,
in no particular order, nothing a finished script read cleanly start to
finish. HISHIN takes that raw footage plus a brief (what the video is
for, target length) and:

1. Transcribes and inspects every take (AWS Transcribe).
2. Selects the strongest sentences across all of them — not take 1 then
   take 2 then take 3, but whichever order actually tells the story,
   judged by content.
3. Cuts, subtitles, and mixes a real rendered video with deterministic
   FFmpeg tooling — every cut is a measured timestamp, never a guess.
4. Has a second agent critique the result against the brief (duration,
   coherence, a real call to action, brand consistency from sampled
   frames) and sends it back for another pass if it falls short.
5. Keeps every version it ever produced — nothing overwrites a previous
   attempt, nothing publishes silently.

If the footage is missing something the brief needs — a call to action
nobody actually said on camera — HISHIN can write that line and generate
a real voice-over for it (Amazon Polly, word-timing measured, not
estimated), but only if you explicitly allow it for that run.

Built with the [Strands Agents SDK](https://strandsagents.com) and Amazon
Bedrock: a **Director** agent (Claude Sonnet 4.6) plans the edit and
calls a dozen typed tools wrapping a from-scratch FFmpeg pipeline; a
**Critic** agent (Claude Haiku 4.5) evaluates the render and returns
`PASS` or a structured `REVISE`. Full diagrams in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

A separately hosted, multi-user deployment of this same core is live at
https://hishin.globalnavigator.app.

## Quick start

**Prerequisites:**
- Node.js 24, npm
- FFmpeg and FFprobe on the `PATH` (macOS: `brew install ffmpeg`)
- An AWS account with:
  - Access enabled for the Bedrock models
    `us.anthropic.claude-sonnet-4-6` and
    `us.anthropic.claude-haiku-4-5-20251001-v1:0` in `us-east-1` (Bedrock
    console → Model access)
  - An S3 bucket for AWS Transcribe's scratch audio (any name; the app
    writes under a `hishin/` prefix and never makes it public)
  - Credentials available through the standard AWS SDK chain (env vars,
    `~/.aws/credentials`, or an SSO profile — never pasted into this repo)

```sh
git clone https://github.com/MENGUEDAVIS/hishin.git
cd hishin
npm ci
cp .env.example .env
# edit .env: set TRANSCRIBE_S3_BUCKET to your bucket name
npm run check:setup   # confirms Node/FFmpeg/FFprobe are all reachable
npm run typecheck
```

Then, in two separate terminals:

```sh
npm run server    # http://127.0.0.1:3001
npm run ui:dev     # http://localhost:5173
```

Open http://localhost:5173. No login, no account — you land straight on
the Dashboard.

## Try it end to end

1. **New edit** → write a one-line brief (e.g. "a 30-second product
   intro, hook, explanation, call to action") and a target duration.
2. Drop in two or three real video takes (any phone footage works — a
   few sentences per take is enough to see the selection behavior).
3. Click **Import media**, then **Start the edit**.
4. Watch **Edit progress** update live: the Director inspects the
   footage, builds a plan, and calls `assemble_edit`; the Critic then
   returns `PASS` or `REVISE` with concrete issues. A full round
   (transcription + Bedrock calls + FFmpeg render) takes a few minutes.
5. Open **History** to watch the render, see exactly which sentence from
   which take was chosen for each segment and why, and read the Critic's
   verdict. If it revises, every earlier attempt stays there too.

Running the server/UI/upload without AWS credentials still works for
ingesting footage and browsing the interface; starting an actual edit
requires the AWS access described above (Bedrock + Transcribe, and
Polly if narration is enabled for that run).

## Dashboard and edit history

**History** lets you search past renders, filter by verdict, and open any
version to watch the video, review the segments it kept, and read the
agents' reasoning. `GET /api/library` discovers projects and render
manifests already present under `DATA_DIR/projects`, including ones
produced earlier via the CLI — older videos stay visible even without an
agent review record, and missing information or deleted files are called
out explicitly rather than hidden.

Server sessions are saved atomically to `projects/<id>/jobs/<jobId>.json`.
A restart marks any unfinished session as errored rather than silently
resuming it. Only one edit per project can run at a time.

## AWS details

The SDK uses the standard AWS credential chain, including CLI profiles.
Region: `us-east-1`. `TRANSCRIBE_S3_BUCKET` should point at a bucket with
public access blocked; the app writes scratch audio under a `hishin/`
prefix and doesn't delete it itself — add a lifecycle rule on the bucket
(e.g. expire objects under that prefix after 7 days) if you want it
cleaned up automatically. `BEDROCK_DIRECTOR_MODEL_ID`
and `BEDROCK_CRITIC_MODEL_ID` must reference models your account actually
has Bedrock access to — `us.anthropic.claude-sonnet-4-6` and
`us.anthropic.claude-haiku-4-5-20251001-v1:0` are what this project was
built and tested against.

Renders run locally; Bedrock, Transcribe, and (opt-in) Polly are called
remotely. Required IAM permissions are limited to the chosen Bedrock
models, Transcribe jobs, and the project's S3 prefix. AWS credentials
never leave the server process.

## License

[MIT](LICENSE).
