# HI-SHIN — Architecture

Two diagrams: the system as this repository runs it (request path, storage,
AWS services it calls), and the agent loop itself — the part that actually
decides what goes in the video.

A separately hosted, multi-user deployment of this same core (with
Cognito login and per-account isolation) exists at
[hishin.globalnavigator.app](https://hishin.globalnavigator.app) as a live
demo; that hosting layer is additional infrastructure around this repo, not
part of it, and isn't shown below — this repo runs standalone, no login
required.

## System architecture

```mermaid
flowchart TB
    subgraph Client["Browser"]
        U["Creator"]
    end

    subgraph Compute["Express server (src/server/)"]
        direction TB
        Express["Static SPA + REST API"]
        Jobs["Job store\none Director<->Critic run per project"]
        Pipeline["Deterministic pipeline\n01-ingest .. 09-photo-clip (FFmpeg/FFprobe)"]
        Director["Director agent\n(Strands + Bedrock)"]
        Critic["Critic agent\n(Strands + Bedrock)"]
        Tools["Strands tool registry\ntyped wrappers over the pipeline"]
    end

    subgraph Storage["Local storage (DATA_DIR)"]
        Disk["Project files + SQLite\nraw takes, transcripts, renders, job state"]
        S3["S3 (7-day expiry)\nTranscribe audio scratch"]
    end

    subgraph AWS["AWS AI services"]
        Bedrock["Amazon Bedrock\nClaude Sonnet 4.6 (Director)\nClaude Haiku 4.5 (Critic)"]
        Transcribe["AWS Transcribe"]
        Polly["Amazon Polly\n(opt-in narration only)"]
    end

    U -->|HTTP| Express --> Jobs --> Director
    Director <--> Tools --> Pipeline
    Pipeline --> Disk
    Pipeline --> S3 --> Transcribe
    Director --> Bedrock
    Critic --> Bedrock
    Tools -.->|only if allowNarration=true| Polly
    Director -->|REVISE loop, bounded rounds| Critic
    Jobs --> Disk
```

Notes that matter more than the boxes:

- **The pipeline and agents have no concept of users.** They only ever know
  a `projectId`. That's what let a multi-user hosted deployment (Cognito
  login, per-account isolation) be added as a layer *around* this system
  without touching the media pipeline or the agent loop at all.
- **Amazon Polly is opt-in, not automatic.** `list_voices`/`synthesize_narration`
  are only registered as tools for the Director when the human explicitly
  sets `allowNarration: true` for that run — otherwise the model literally
  cannot call them, not just discouraged from it by a prompt.
- **AWS credentials come from the standard SDK chain** (env vars, shared
  config/profile, or an execution role if you deploy this yourself) — never
  hardcoded, never passed through the agent.

## The agent loop

```mermaid
flowchart LR
    Brief["Brief + optional script\ntarget duration, takes, photos"]
    Director["Director\n(Strands Agent, Claude Sonnet 4.6)"]
    Tools["inspect_take · transcribe_take\nderush_project · tighten_take\nresolve_segments\nsynthesize_narration (opt-in)\nassemble_edit · generate_subtitles\nprepare_sound_library · mix_final"]
    Deterministic["Deterministic resolution\ntimestamps from real transcript/tighten/\nPolly speech-mark data, never invented"]
    Render["Rendered video + manifest"]
    Critic["Critic\n(Strands Agent, Claude Haiku 4.5,\nstructured output)"]
    Human["Human review\n(History — every round kept)"]

    Brief --> Director
    Director <-->|tool calls| Tools
    Tools --> Deterministic --> Render
    Render --> Critic
    Critic -->|PASS| Human
    Critic -->|REVISE + structured issues| Director
```

The one rule the whole system exists to enforce: **the Director selects
semantic IDs (`take_04_s02`, a `narration_id` it just generated) — it never
supplies a timestamp.** `assemble_edit` resolves every ID against real
transcript/tighten/Polly data on disk; an ID that doesn't resolve fails the
tool call loudly, with no render produced. That boundary is asserted by a
scripted adversarial test in `tests/integration/agent-tools.spec.ts`, not
just by the system prompt.

The Critic never edits video. It receives the brief, the *measured* duration
(ffprobe, never recomputed by the model), the subtitle/narration text, and
sampled frames — and returns `PASS` or `REVISE` with structured issues
(`duration`, `cta`, `coherence`, `brand`, `audio`, `other`). Revisions are
bounded (`MAX_REVISION_ROUNDS`); every round's render, editorial reasoning,
and critique stay in history, even if the loop ends on `REVISE` rather than
`PASS` — the system reports what it actually achieved, it doesn't force a
passing grade.
