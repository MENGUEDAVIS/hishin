# HI-SHIN — Architecture

Two diagrams: the production system (request path, AWS services, multi-user
isolation), and the agent loop itself (the part that actually decides what
goes in the video). Both reflect what is deployed at
[hishin.globalnavigator.app](https://hishin.globalnavigator.app), not a
planned or aspirational version.

## System architecture

```mermaid
flowchart TB
    subgraph Client["Browser"]
        U["Creator"]
    end

    subgraph Edge["Route 53 + ACM"]
        DNS["hishin.globalnavigator.app"]
    end

    subgraph LB["Application Load Balancer"]
        Pub["/ and /logged-out\n(public, no auth)"]
        Api["/api/*\n(authenticate-cognito, deny)"]
        App["/app/*\n(authenticate-cognito, authenticate)"]
    end

    subgraph Idp["Amazon Cognito"]
        Pool["User Pool (Essentials)\nManaged Login v2, custom branding"]
    end

    subgraph Compute["ECS Fargate — single task"]
        direction TB
        Express["Express server\nlanding page / SPA static / REST API"]
        Auth["requireAuth\nverifies ALB-signed ES256 JWT itself"]
        Owner["Ownership layer\nprojects scoped to Cognito sub"]
        Jobs["Job store\none Director<->Critic run per project"]
        Pipeline["Deterministic pipeline\n01-ingest .. 09-photo-clip (FFmpeg/FFprobe)"]
        Director["Director agent\n(Strands + Bedrock)"]
        Critic["Critic agent\n(Strands + Bedrock)"]
        Tools["Strands tool registry\ntyped wrappers over the pipeline"]
    end

    subgraph Storage["Persistent storage"]
        EFS["EFS (encrypted)\nprojects, renders, ownership + job SQLite"]
        S3["S3 (7-day expiry)\nTranscribe audio scratch"]
    end

    subgraph AWS["AWS AI services"]
        Bedrock["Amazon Bedrock\nClaude Sonnet 4.6 (Director)\nClaude Haiku 4.5 (Critic)"]
        Transcribe["AWS Transcribe"]
        Polly["Amazon Polly\n(opt-in narration only)"]
    end

    U -->|HTTPS| DNS --> LB
    Pub -->|forward, unauthenticated| Express
    App -->|forward + signed identity header| Express
    Api -->|forward + signed identity header| Express
    App -.->|no valid session| Pool
    Api -.->|no valid session, 401 not redirect| Pool
    Pool -.->|OIDC code exchange| LB

    Express --> Auth --> Owner --> Jobs --> Director
    Director <--> Tools --> Pipeline
    Pipeline --> EFS
    Pipeline --> S3 --> Transcribe
    Director --> Bedrock
    Critic --> Bedrock
    Tools -.->|only if allowNarration=true| Polly
    Director -->|REVISE loop, bounded rounds| Critic
    Owner --> EFS
    Jobs --> EFS
```

Notes that matter more than the boxes:

- **`/` is not behind Cognito.** The marketing landing page is a single
  self-contained HTML file (inline CSS/JS/images) so it can be the one ALB
  path exempt from auth without leaking a login-gated stylesheet request.
  Everything else — `/app` (the SPA) and `/api` (the REST surface) — sits
  behind the ALB's `authenticate-cognito` action.
- **The app never trusts the ALB blindly.** `authenticate-cognito` attaches a
  signed `x-amzn-oidc-data` header; `requireAuth` (`src/server/auth.ts`)
  independently re-verifies its ES256 signature against ALB's own public key
  endpoint, and checks `signer`/`client`/`exp` itself. A misconfigured
  security group reaching the task directly still can't get in.
- **Multi-user isolation lives in exactly one place.** The pipeline and
  agents only ever know a `projectId` — they have no concept of users. A
  separate ownership table (`project_owners`, keyed by Cognito `sub`) is the
  only thing that maps a project to an account, enforced at the server layer
  before any route touches project data.
- **Amazon Polly is opt-in, not automatic.** `list_voices`/`synthesize_narration`
  are only registered as tools for the Director when the human explicitly
  sets `allowNarration: true` for that run — otherwise the model literally
  cannot call them, not just discouraged from it by a prompt.
- **One task, on purpose.** This is a hackathon-to-production pilot, not a
  claim of high availability: a single Fargate task, deployed with
  start-before-stop rollout and a long ALB deregistration delay so an
  in-flight upload survives a deploy, but still one process.

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
