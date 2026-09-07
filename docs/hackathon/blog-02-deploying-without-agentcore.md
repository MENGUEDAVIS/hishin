# Agents for Humans: Deploying a Multi-User Agent Product Without Bedrock AgentCore

HI-SHIN is deployed at a real domain, behind real signup/login, isolating
real projects between real users — and it doesn't use Amazon Bedrock
AgentCore anywhere. That was a deliberate choice, not an oversight, and
since "should we use AgentCore" is a question worth answering honestly
rather than by default, this is the reasoning plus what we built instead.

## What we actually had to solve

The agent part of HI-SHIN — a Strands Director and Critic calling Amazon
Bedrock — was never the hard part of going to production. Once the agent
loop worked locally, the remaining problems were: how do multiple real
people sign up and log in, how do we make sure user A can never see user
B's project, how do we run this on infrastructure we don't have to
babysit, and how do we deploy changes without breaking whatever's currently
running for a real user.

None of those are agent problems. They're the same problems any multi-user
web product has, and AWS already has first-class managed services for
every one of them — just not inside AgentCore.

## What we built

- **Amazon Cognito** for signup/login, with the Hosted UI's newer **Managed
  Login** (v2) and a custom branding pass (logo, colors matching the
  product) instead of the plain default page — moved from the Lite to the
  Essentials tier specifically because Managed Login's branding editor
  isn't available on Lite. Same free tier (10,000 MAU/month) either way at
  this scale.
- **An Application Load Balancer doing the actual authentication.** ALB has
  a native `authenticate-cognito` listener action — it runs the OIDC
  handshake and attaches a signed identity header to every request *before*
  it reaches our container. We don't hand-roll session cookies.
- **Defense in depth anyway.** The app re-verifies that ALB-signed header
  itself (ES256 signature against ALB's own public-key endpoint, checked
  `signer`/`client`/`exp`) rather than trusting it blindly — a
  misconfigured security group reaching the task directly still can't get
  in pretending to be an authenticated request.
- **Multi-user isolation as one small, separate layer.** The media
  pipeline and the agents never learned about users — they only know a
  `projectId`. A single ownership table, keyed by the Cognito `sub`,
  decides which project belongs to which account, enforced once at the
  server layer. This kept a system that was already built and tested from
  needing to be rewritten for multi-tenancy.
- **ECS Fargate, EFS, S3, CloudFormation, CodeBuild** for the rest: one
  Fargate task running the Express server, EFS for persistent project
  state (media, SQLite), S3 with a 7-day expiry for Transcribe's audio
  scratch space, infrastructure fully defined in CloudFormation, images
  built by CodeBuild (no local Docker required).

## The part that actually went wrong, and what it taught us

Two real production incidents, both fixed the same day they were found,
both worth stating plainly instead of glossing over:

**Every deploy was killing in-flight uploads.** The ECS service was
configured to fully stop the old task before starting the new one
(`minimumHealthyPercent=0`), and the ALB's deregistration delay was 30
seconds — nowhere near enough for a multi-gigabyte multi-video upload.
Every deploy during active use silently severed whatever upload was in
progress. Fixed by starting the new task before retiring the old one
(`minimumHealthyPercent=100`, `maximum=200`) and raising the
deregistration delay to 30 minutes, so an in-flight request actually
survives a deploy instead of racing it.

**The server's own request timeout was shorter than a real upload.**
Node's default `requestTimeout` (5 minutes) counts the *entire* request,
body included — a large multi-take upload on an ordinary connection can
take longer than that, and Node aborts the socket with a 408 before the
upload route ever runs. Raised to 30 minutes, matched by the ALB's own
idle timeout.

Neither of these is an agent bug. They're exactly the kind of
infrastructure detail that a fully managed agent runtime doesn't
automatically get right for you either — they're specific to *this*
system's actual traffic pattern (large file uploads, long-running
requests), and they had to be found by watching real usage, not assumed
away by picking a more "modern" hosting layer.

## Why not AgentCore, specifically

We went through AgentCore's actual components — Runtime, Memory, Gateway,
Identity, the browser and code-interpreter tools — against what HI-SHIN
needs, in more depth in
[`docs/hackathon/agentcore-decision.md`](agentcore-decision.md). The short
version: HI-SHIN's state isn't conversational memory, its tools aren't
third-party APIs needing gateway translation, its auth is already solved
with Cognito + ALB, and its tools are FFmpeg and AWS SDK calls, not
browsing or code execution. Every piece of AgentCore we checked would have
duplicated something already built and tested, not fixed a real gap — and
migrating a working, deployed, multi-user system in the last week of a
hackathon window to gain an optional scoring strengthener is a trade we
were not willing to make against the risk of breaking what already works.

The honest summary: the hard part of shipping an agent product to real
users usually isn't the agent. It's everything around it — auth,
isolation, deploys that don't silently drop someone's upload. Managed
services solve most of that well, whichever specific ones you pick; the
job is picking the ones that match what you actually built, not the ones
that sound most agent-native.
