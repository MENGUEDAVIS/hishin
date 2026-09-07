# Agents for Humans: Why We Never Let the Model Touch a Timestamp

We built HI-SHIN, a video-production agent, on top of one rule we decided
before writing a single line of agent code: **the agent decides what to
cut. Deterministic tools decide where to cut.** This post is about why that
rule exists, what it actually costs to enforce, and how we proved — not
just asserted — that it holds under pressure.

## The temptation

A large language model can watch a transcript and tell you, correctly, that
sentence six is a stronger opening than sentence one. It can spot that two
sentences make the same point and one should go. Those are real editorial
judgments, and Claude is good at them.

It is much less good at being a frame-accurate clock. Ask a model "how long
does this sentence take to say" and it will answer — fluently, and wrong by
enough that a video editing pipeline built on that number silently drifts
out of sync. The failure mode isn't a crash. It's a video that's subtly,
untestably off, because the foundation was a guess wearing the confidence
of a fact.

So the rule for HI-SHIN's Director agent (Strands, Claude Sonnet 4.6, on
Amazon Bedrock) is structural, not a prompt suggestion: it can select a
`sentence_id` from a real transcript, a `fragment_id` from a real
silence-trimmed take, or a `narration_id` from a voice-over it just
generated — and that's the entire vocabulary it has for referring to
content. There is no field in any tool's input schema for a start time, an
end time, or a duration. Not "the model is told not to invent one" — there
is nowhere to put one if it tried.

## Where the actual boundary lives

`assemble_edit`, the tool that produces a real rendered file, resolves
every ID the Director gives it against transcript/tighten/narration data
that already exists on disk — timestamps from AWS Transcribe's word-level
alignment, silence boundaries measured by FFmpeg, narration duration and
word timing from Amazon Polly's speech marks (measured after synthesis,
never estimated before it). If an ID doesn't resolve — a typo, a
hallucinated sentence number, anything — the tool call fails loudly and no
file is produced.

That's the design. The interesting engineering question is: how do you
know it actually holds, instead of just reading correctly in the prompt?

## Proving it, adversarially

We wrote a scripted, deterministic stand-in for the model specifically to
attack this boundary: feed it a `segment_id` that was never resolved from
any real transcript, and assert that `assemble_edit` refuses the call and
that no render exists afterward. Not "the happy path works" — "the system
correctly says no." That test lives in
`tests/integration/agent-tools.spec.ts`, runs against the real tool layer
(no HTTP mocks), and is the one we'd point a skeptical reviewer to first.

Getting that test running had its own detour worth mentioning honestly:
our test runner (Jest) couldn't follow the `tsx` loader's mapping from a
`.js` import specifier to the actual `.ts` source file our agent code
imports — a module-resolution mismatch that had nothing to do with the
thing we were trying to prove. Rather than fight the test runner with a
custom resolver for marginal benefit, that one file runs as a standalone
`node --import tsx` script with `node:assert/strict`, same as every CLI
script in this repo. Pragmatic, not elegant, and clearly commented as to
why.

## Where this got genuinely hard: generated narration

The rule is easy to hold when the agent only *selects* real footage. It
gets harder the moment the agent can *generate* content — because now
there's a real temptation to let it also estimate that content's duration,
just this once, since it wrote the words itself.

We didn't take that shortcut. When the Director decides a hook or
call-to-action is missing from the real footage, it calls
`synthesize_narration` with the text it wrote — and Amazon Polly actually
speaks it, with `SpeechMarkTypes: ['word']` requested so we get real
word-level timing back, not an estimate. The Director is then required to
reference the returned `narration_id`, exactly like a `sentence_id` — the
same resolution path, the same "if it doesn't exist, the tool call fails"
guarantee. Subtitle projection uses that same measured timing. Nothing
downstream ever sees a number the model invented.

## What this bought us, concretely

In a real end-to-end run (documented in full in
`docs/architecture.md`), the Director's first cut came in under the target
duration and the raw footage had no explicit call to action. Because
narration is measured rather than estimated, extending the CTA by writing
one more sentence and re-synthesizing it produced a video within a second
of the target — not "roughly" within a second, because rendering,
subtitle-sync, and loudness normalization all key off measurements that
were true from the start.

The broader lesson, which we think generalizes past video editing: a
reliable agentic system doesn't need the model to be right about
everything. It needs a clear, enforced line between the things that are
genuinely subjective — and the things that are just measurements wearing a
model's confidence. Draw that line in the schema, not just the prompt, and
prove it holds by trying to break it.
