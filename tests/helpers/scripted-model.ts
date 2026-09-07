import {
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

/**
 * A deterministic, scripted stand-in for a real model provider. Each call to
 * stream() consumes the next scripted turn — either one or more tool calls,
 * or a final text answer — so agent tests can prove real tool-call
 * sequencing and the STRICT RULE's enforcement without any network access
 * or AWS credentials.
 */

export interface ScriptedToolCall {
  name: string;
  input: Record<string, unknown>;
}

export type ScriptedTurn = { type: 'tool_calls'; calls: ScriptedToolCall[] } | { type: 'text'; text: string };

export class ScriptedModel extends Model<BaseModelConfig> {
  private readonly turns: ScriptedTurn[];
  private cursor = 0;
  private config: BaseModelConfig = {};

  /** Every messages array this model was called with, in order — for assertions. */
  readonly callHistory: Message[][] = [];

  constructor(turns: ScriptedTurn[]) {
    super();
    this.turns = turns;
  }

  updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): BaseModelConfig {
    return this.config;
  }

  async *stream(messages: Message[], _options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    this.callHistory.push(messages);
    const callIndex = this.cursor;
    const turn = this.turns[callIndex];
    this.cursor += 1;
    if (!turn) {
      throw new Error(`ScriptedModel: ran out of scripted turns at call #${callIndex + 1}`);
    }

    yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' });

    if (turn.type === 'text') {
      yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' });
      yield new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: turn.text },
      });
      yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
      yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'endTurn' });
    } else {
      for (const [callOffset, call] of turn.calls.entries()) {
        yield new ModelContentBlockStartEvent({
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: call.name, toolUseId: `scripted_${callIndex}_${callOffset}` },
        });
        yield new ModelContentBlockDeltaEvent({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: JSON.stringify(call.input) },
        });
        yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' });
      }
      yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'toolUse' });
    }

    yield new ModelMetadataEvent({
      type: 'modelMetadataEvent',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    });
  }
}
