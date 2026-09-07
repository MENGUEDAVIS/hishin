import { z } from 'zod';

/**
 * The Editorial Plan Model from the brief, extended with two additional
 * segment kinds beyond cutting real footage. In every kind the agent
 * supplies semantic content only — an id referencing already-resolved
 * data, or new text to synthesize — never a timestamp or a duration it
 * measured itself:
 *
 * - `take`      — a sentence_id (inspect_take) or fragment_id (tighten_take)
 *                 from real footage. Timestamps: resolved from transcript/
 *                 tighten data, exactly as before.
 * - `narration` — a narration_id from synthesize_narration (the agent wrote
 *                 the text, Polly spoke it). Duration: Polly-measured.
 * - `photo`     — a photo_id from an uploaded image, shown for an agent-
 *                 chosen pacing duration (bounded, not a footage timestamp).
 *
 * Mirrored by the plain-JS EditPlanSchema inside src/pipeline/04-assemble.js
 * so that module stays independently runnable via scripts/pipeline.js
 * without depending on this TypeScript layer. Keep both in sync if the
 * shape changes.
 */

export const SEGMENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export const SegmentRoleSchema = z.enum(['hook', 'body', 'cta']);
export type SegmentRole = z.infer<typeof SegmentRoleSchema>;

export const TakeSegmentSchema = z.object({
  kind: z.literal('take'),
  segment_id: z
    .string()
    .regex(SEGMENT_ID_PATTERN)
    .describe('A sentence_id (from inspect_take) or fragment_id (from tighten_take). Never a timestamp.'),
  role: SegmentRoleSchema,
  reason: z.string().min(1).describe('One-sentence editorial justification for including this segment in this role.'),
});
export type TakeSegment = z.infer<typeof TakeSegmentSchema>;

export const NarrationSegmentSchema = z.object({
  kind: z.literal('narration'),
  narration_id: z
    .string()
    .regex(SEGMENT_ID_PATTERN)
    .describe('A narration_id returned by synthesize_narration. You must call that tool before referencing its id here.'),
  photo_id: z
    .string()
    .regex(SEGMENT_ID_PATTERN)
    .optional()
    .describe('Show this uploaded photo while the narration plays. Omit to hold a neutral background.'),
  role: SegmentRoleSchema,
  reason: z.string().min(1),
});
export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;

export const PhotoSegmentSchema = z.object({
  kind: z.literal('photo'),
  photo_id: z.string().regex(SEGMENT_ID_PATTERN),
  duration_seconds: z
    .number()
    .positive()
    .max(10)
    .describe('How long to hold this photo, in seconds. A pacing choice, not a footage measurement — keep it short (1-6s typical).'),
  caption: z.string().max(200).optional().describe('Optional short burned-in caption, e.g. a product name or CTA line.'),
  role: SegmentRoleSchema,
  reason: z.string().min(1),
});
export type PhotoSegment = z.infer<typeof PhotoSegmentSchema>;

export const EditorialSegmentSchema = z.discriminatedUnion('kind', [
  TakeSegmentSchema,
  NarrationSegmentSchema,
  PhotoSegmentSchema,
]);
export type EditorialSegment = z.infer<typeof EditorialSegmentSchema>;

export const BrandConfigSchema = z
  .object({
    width: z.number().int().positive().max(1920).optional(),
    height: z.number().int().positive().max(1920).optional(),
    fps: z.number().int().positive().max(30).optional(),
  })
  .passthrough();

export const EditorialPlanSchema = z.object({
  objective: z.string().optional(),
  target_duration_seconds: z.number().positive().optional(),
  output_format: z.enum(['mp4', 'mov']).default('mp4'),
  brand_config: BrandConfigSchema.optional(),
  segments: z
    .array(EditorialSegmentSchema)
    .min(1).max(60)
    .describe('Ordered final cut: hook segment(s) first, then body, then cta. Mix kinds freely.'),
});
export type EditorialPlan = z.infer<typeof EditorialPlanSchema>;
