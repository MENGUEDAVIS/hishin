# Should HI-SHIN adopt Amazon Bedrock AgentCore for this submission?

**Recommendation: no — not for this submission, and the reasoning is itself
worth stating in the submission rather than hiding the omission.**

## What the rule actually says

> "Deploying with Amazon Bedrock AgentCore is a smart architectural choice
> and will strengthen your Technical Implementation score, but it's not
> required." — and separately, a live demo *also* strengthens that same
> score.

It is one optional strengthener among several, on one of five **equally
weighted** judging criteria. It is not a gate.

## What AgentCore actually provides

AgentCore is a managed hosting and tooling layer for agents: a sandboxed
**Runtime** so you don't operate your own compute for the agent loop, a
**Memory** service for conversational/session state, a **Gateway** for
turning existing APIs into agent-callable tools, an **Identity** service for
delegated auth, and built-in **browser**/**code-interpreter** tools.

## Why it doesn't fit HI-SHIN's actual architecture

Going through each piece honestly, against what this system actually needs:

- **Runtime (managed sandbox for agent execution).** HI-SHIN already runs
  its agent loop inside a normal ECS Fargate task, deployed with real
  multi-user auth (Cognito + ALB), persistent state (EFS), and a working
  CI/CD pipeline (CodeBuild → ECR → CloudFormation). Migrating the Director
  and Critic to run inside AgentCore Runtime instead would mean re-plumbing
  authentication, file access (EFS-backed project state, FFmpeg-produced
  media), and the job/polling model this session already hardened —
  for a system that is not "how do I host my agent" limited in the first
  place.
- **Memory.** HI-SHIN's state isn't conversational memory — it's
  deterministic project artifacts (transcripts, tighten fragments, render
  manifests) on disk, addressed by ID. There's no chat history to manage
  across turns that AgentCore Memory would meaningfully replace.
- **Gateway.** The tools the Director calls are typed, in-process Strands
  tools wrapping this repo's own pipeline modules — there's no third-party
  API needing protocol translation into agent-callable form.
- **Identity.** Multi-user auth is already solved end-to-end with Cognito +
  ALB-native `authenticate-cognito`, verified independently by the app
  (`src/server/auth.ts`). AgentCore Identity would duplicate, not improve,
  a working boundary.
- **Browser / code-interpreter tools.** HI-SHIN's tools are FFmpeg/FFprobe
  calls and AWS SDK calls (Transcribe, Polly) — not web browsing or
  arbitrary code execution.

None of AgentCore's actual value propositions address a real gap in this
system. Adopting it would mean restructuring a **working, tested, deployed,
multi-user production system** in the final week of the submission window,
purely to check a box that's explicitly marked optional — for a scoring
strengthener that a live demo (which HI-SHIN already has, at
hishin.globalnavigator.app) already partly covers.

## What actually strengthens Technical Implementation instead

The judging question is "how thoroughly and skillfully does the project use
Strands Agents" and "is there a working, non-trivial implementation" — both
of which HI-SHIN answers directly, without AgentCore:

- A real two-agent loop (Director → Critic → revise, bounded rounds) with
  structured output, not a single prompt-and-done call.
- Ten-plus typed Strands tools wrapping a from-scratch deterministic media
  pipeline (FFmpeg/FFprobe), with a hard architectural boundary — the model
  selects semantic IDs, it can never supply a timestamp — enforced in code
  and proven with an adversarial test, not just asserted in a prompt.
- A live, publicly reachable, multi-user deployment with real Cognito auth,
  not a local-only demo.

That case is made honestly and in more depth in
[`docs/hackathon/blog-02-deploying-without-agentcore.md`](blog-02-deploying-without-agentcore.md),
which is written specifically so a judge reading it sees deliberate
engineering judgment rather than an unexplained gap.

## If this changes

If more of the submission window remains than assumed here, or the team
decides the AgentCore Runtime specifically (just the hosting piece, not the
rest of the suite) is worth trying as a genuinely separate experiment
*alongside* the current deployment (not replacing it under deadline
pressure), that would be the one piece worth prototyping — it's the only
AgentCore component with any real surface overlap with what this system
does. That should be scoped as its own low-risk branch, tested against the
same real-AWS test suite already in place, never as a same-week replacement
of the working production deployment.
