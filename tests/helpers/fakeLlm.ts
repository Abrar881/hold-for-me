import type { LlmCall, LlmMessage, LlmParams } from '../../src/server/llm.js';
import type { Anthropic } from '@anthropic-ai/sdk';

export type FakeTurn = {
  text?: string;
  tools?: { name: string; input: object }[];
  stop?: 'end_turn' | 'tool_use' | 'refusal';
};

type ScriptEntry = FakeTurn | ((p: LlmParams) => FakeTurn);

function buildMessage(turn: FakeTurn, n: number): LlmMessage {
  const stop_reason = turn.stop ?? (turn.tools?.length ? 'tool_use' : 'end_turn');

  const content: LlmMessage['content'] = [];

  if (turn.text !== undefined) {
    // Cast: test helper doesn't need every BetaTextBlock required field
    content.push({ type: 'text', text: turn.text, citations: null } as LlmMessage['content'][number]);
  }

  if (turn.tools) {
    for (let i = 0; i < turn.tools.length; i++) {
      const t = turn.tools[i];
      content.push({
        type: 'tool_use',
        id: `tu_${n}_${i}`,
        name: t.name,
        input: t.input,
      } as LlmMessage['content'][number]);
    }
  }

  // If nothing was added, add an empty text block so content is not empty
  if (content.length === 0) {
    content.push({ type: 'text', text: '', citations: null } as LlmMessage['content'][number]);
  }

  return {
    id: `msg_fake_${n}`,
    type: 'message',
    role: 'assistant',
    content,
    model: 'fake',
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
  } as LlmMessage;
}

export function fakeLlm(script: ScriptEntry[]): LlmCall & { calls: LlmParams[] } {
  const calls: LlmParams[] = [];
  let idx = 0;

  const fn = async (p: Omit<LlmParams, 'model'>): Promise<LlmMessage> => {
    const fullParams = { ...p, model: 'fake' } as LlmParams;
    calls.push(fullParams);

    if (idx >= script.length) {
      throw new Error(`fakeLlm: script exhausted at call ${idx + 1} (script has ${script.length} entries)`);
    }

    const entry = script[idx++];
    const turn = typeof entry === 'function' ? entry(fullParams) : entry;
    return buildMessage(turn, idx);
  };

  (fn as LlmCall & { calls: LlmParams[] }).calls = calls;
  return fn as LlmCall & { calls: LlmParams[] };
}
