# HI-SHIN — Devpost submission text

**Track: Professional Agents** — HI-SHIN targets creators, social-media
teams, and small businesses: people who make video regularly and lose real
time to the repetitive, judgment-heavy part of it (watching every take,
picking the strongest moments, cutting dead air, syncing captions,
mixing sound) rather than the part that needs their actual voice.

## What it does

You record several takes for a video — in any order, some stronger than
others, none of them a finished script read cleanly start to finish. You
give HI-SHIN a brief (what the video is for, tone, length) and, optionally,
the shooting script you meant to read on camera. HI-SHIN:

1. Transcribes and inspects every take.
2. Selects the strongest sentences across all of them — not take 1 then
   take 2 then take 3, but whichever order actually tells the story, judged
   by content, not by which take or file it came from.
3. Cuts, subtitles, and mixes a real rendered video using deterministic
   FFmpeg tooling — never a guessed timestamp.
4. Has a second agent critique the result against your brief (duration,
   coherence, a real call to action, brand consistency from sampled frames)
   and sends it back for another pass if it falls short.
5. Hands you every version it ever produced — nothing published silently,
   nothing overwritten — so you approve or keep iterating.

If your footage is missing something the brief needs — a call to action no
one actually said on camera — HI-SHIN can write that line and generate a
real voice-over for it (Amazon Polly, word-timing measured, not estimated)
— but only if you explicitly allow it for that run. Off by default.

## Who it's for

Creators, social-media teams, and small businesses who record more footage
than they finish publishing — the people for whom "I have the footage, I
just haven't cut it yet" describes most of their backlog.

## Why it matters

The bottleneck for most people making short-form video isn't having
something to say — it's turning what they already recorded into something
they're willing to post. That work is repetitive and time-consuming, but it
still requires judgment (which take is stronger, which sentence repeats an
idea already said better elsewhere) — exactly the kind of task where an
agent that can *reason* about content, and not just execute a template, is
the right tool.

## How it works (the part worth judging closely)

The one architectural decision the whole system is built around:

> **The agent decides what to cut. Deterministic tools decide where to
> cut.**

A language model is good at judging that one take's opening is stronger
than another's, or that two sentences repeat the same point. It is not a
frame-accurate clock. So the Director (a Strands Agent on Amazon Bedrock,
Claude Sonnet 4.6) never touches a timestamp — it selects semantic IDs
(`take_04_s02`, or a `narration_id` from a voice-over it just generated),
and a deterministic tool (`assemble_edit`) resolves every one of those IDs
against real transcript/tighten/Polly data on disk. An ID that doesn't
resolve fails the tool call loudly and produces no render — proven with an
adversarial test that feeds the agent a fabricated segment ID and asserts
the system refuses rather than guessing.

A second agent (Critic, Claude Haiku 4.5, structured output) evaluates the
rendered result against the brief — using the *measured* duration from
ffprobe, never a number the model invented — and returns `PASS` or a
structured `REVISE` with concrete issues. The Director addresses every
blocker and re-renders; the loop is bounded, and every round's render,
reasoning, and critique stay reviewable, whether or not it ever reaches
`PASS`.

Full architecture diagrams (system + agent loop): [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## What's real vs. planned

Everything above is deployed and tested with real AWS calls — real Bedrock
invocations, real AWS Transcribe jobs, real Amazon Polly synthesis, real
FFmpeg renders — not mocked. The live deployment is a real multi-user
product: Amazon Cognito signup/login (Essentials tier, Managed Login with
custom branding), per-user project isolation enforced server-side, and a
public landing page separate from the authenticated app.

**Amazon Bedrock AgentCore is deliberately not used.** See
[`docs/hackathon/agentcore-decision.md`](agentcore-decision.md) for the
reasoning — in short, none of AgentCore's actual components (managed
runtime, memory, gateway, identity, browser/code-interpreter tools) address
a real gap in a system whose hosting, auth, and tool layer are already
built and working.

## Live demo

https://hishin.globalnavigator.app
