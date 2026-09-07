import type { Usage } from '@strands-agents/sdk';

/**
 * Cost is only ever computed from explicitly configured USD-per-million-token
 * rates (.env `*_INPUT_USD_PER_MILLION` / `*_OUTPUT_USD_PER_MILLION`). A
 * blank rate means an unknown cost, never a guessed one.
 */
export function computeCost(role: 'director' | 'critic', usage: Usage): number | null {
  const prefix = role === 'director' ? 'DIRECTOR' : 'CRITIC';
  const inputRate = Number(process.env[`${prefix}_INPUT_USD_PER_MILLION`]);
  const outputRate = Number(process.env[`${prefix}_OUTPUT_USD_PER_MILLION`]);
  if (!process.env[`${prefix}_INPUT_USD_PER_MILLION`] || !process.env[`${prefix}_OUTPUT_USD_PER_MILLION`]) {
    return null;
  }
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;
  return (usage.inputTokens / 1_000_000) * inputRate + (usage.outputTokens / 1_000_000) * outputRate;
}
