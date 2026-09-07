import { z } from 'zod';

/**
 * Structured output contract for the HI-SHIN Critic agent. Duration is
 * always filled in by the run-loop from ffprobe measurement before the
 * model answers — the Critic is instructed to compare, never recompute it.
 */

export const CritiqueIssueSchema = z.object({
  category: z.enum(['duration', 'coherence', 'cta', 'brand', 'audio', 'other']),
  severity: z.enum(['blocker', 'warning']),
  description: z.string().min(1),
  suggestion: z.string().optional(),
});
export type CritiqueIssue = z.infer<typeof CritiqueIssueSchema>;

export const CritiqueSchema = z.object({
  verdict: z.enum(['PASS', 'REVISE']),
  summary: z.string().min(1),
  issues: z.array(CritiqueIssueSchema),
});
export type Critique = z.infer<typeof CritiqueSchema>;
