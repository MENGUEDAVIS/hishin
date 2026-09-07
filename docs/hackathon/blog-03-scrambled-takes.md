# Agents for Humans: Teaching a Director Agent to Reconstruct a Story From Scrambled Takes

The easy version of an AI video editor plays your clips back in the order
you recorded them, trims the silence, and calls it done. That's not what we
wanted to build, and it's not what makes HI-SHIN's Director agent
interesting — so we ran a real test to check: given footage recorded in no
particular order, does the agent actually reconstruct a narrative, or does
it just concatenate?

## The test

Three raw takes, filmed back-to-back, no retakes edited out, a real person
talking through a product pitch in French. Nothing in the takes is in a
clean "intro, then features, then close" order — real footage rarely is.
The brief given to the Director was simple: a 60-second product
presentation, hook, explanation, call to action. No instruction about
which take to start with.

Nothing in HI-SHIN's code sorts segments by take number or upload order.
`assemble_edit` renders whatever sequence of segment IDs the Director gives
it, full stop — position 1 in the array is position 1 in the output,
regardless of which of the three takes it came from. Whether the result
tells a real story is entirely a function of whether the model reasons
about content, not an artifact of file order the code enforces for it.

## What actually happened

The Director's first pass opened on a sentence from take one — a warm,
direct personal introduction — followed immediately by a short energetic
bridge line, also from take one, then pivoted to the richest product
explanation available, which lived in take two, tightened to strip
surrounding dead air. It closed on a sentence from take three. The
selection crossed all three takes, out of upload order, chosen because
each sentence was the strongest available match for its role in the story
— hook, body, call to action — not because of where it physically sat in a
file.

## Where it got interesting: the Critic actually held a real line

The first cut ran 6.6 seconds short of the 60-second target and had no
explicit call to action — the raw footage genuinely never contains a line
like "visit our website." The Critic (a separate agent, Claude Haiku 4.5,
structured output, evaluating the *measured* duration from ffprobe and
sampled frames from the real render) flagged both as blockers and declined
to pass it.

The Director's second attempt swapped in a longer closing summary sentence
from the third take to close the duration gap — and overshot instead,
landing at 66 seconds, still without a real call to action, now also
repeating content already covered earlier. Second `REVISE`. Third attempt:
dropped the repetitive summary entirely, replaced the closing line with a
short, genuinely enthusiastic sentence from the first take, landed at 47.8
seconds — within the target range, no repetition — but still no explicit
verbal call to action exists anywhere in the raw footage, because nobody
actually said one on camera. Third `REVISE`.

That's the honest result, and we're stating it plainly rather than
cherry-picking a cleaner run: across three rounds, the system never forced
a `PASS` it hadn't earned. It correctly identified the same real limitation
each time — the footage doesn't contain a call to action, and (for this
run) generated narration was deliberately left off — and said so with a
concrete, actionable suggestion each round instead of pretending the
problem was fixed. Every round's full render, the Director's reasoning for
every segment choice, and the Critic's exact critique stayed available
afterward — nothing was overwritten, nothing silently discarded.

## What this test actually demonstrates

Not "the agent can edit video" — plenty of tools can trim clips. What it
demonstrates is that the selection step is doing real work: reading
transcript content across every available take, judging which sentence
best serves the *role* it needs to fill (hook, body, call to action)
independent of which file or which point in the recording session it came
from, and holding that judgment through multiple rounds of genuine,
substantive feedback from a second model that isn't rubber-stamping the
first one's work.

The failure to reach a final `PASS` is, if anything, the more convincing
part. It would have been trivial to make the Critic more lenient, or to
let the Director pad the runtime with filler just to hit a number. Neither
happened, because neither agent's job is to make the demo look finished —
the Director's job is to make the best edit the real footage supports, and
the Critic's job is to say honestly whether that's good enough. When the
footage itself is the limiting factor — no one said the call to action out
loud — the system reports that, instead of hiding it behind a passing
grade.
