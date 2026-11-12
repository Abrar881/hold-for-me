import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createLlm } from '../src/server/llm.js';
import type { LlmParams } from '../src/server/llm.js';

/** Minimal stub — captures the params passed to beta.messages.create. */
function makeStubClient(handler: (p: LlmParams) => Promise<Anthropic.Beta.Messages.BetaMessage>) {
  return {
    beta: {
      messages: {
        create: vi.fn(handler),
      },
    },
  } as unknown as Anthropic;
}

// Cast to avoid strict BetaMessage/BetaUsage field requirements in tests
const DUMMY_MSG = {
  id: 'm_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'hello', citations: null }],
  model: 'claude-haiku-5-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  },
} as unknown as Anthropic.Beta.Messages.BetaMessage;

describe('createLlm', () => {
  it('adds fallbacks and betas when fallbacks=true', async () => {
    let captured: LlmParams | undefined;
    const client = makeStubClient(async (p) => {
      captured = p;
      return DUMMY_MSG;
    });

    const llm = createLlm(client, { model: 'claude-sonnet-5-5', effort: 'low', fallbacks: true });
    await llm({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 });

    expect(captured?.betas).toContain('server-side-fallback-2026-07-01');
    expect(captured?.fallbacks).toBe('default');
  });

  it('omits fallbacks when fallbacks=false', async () => {
    let captured: LlmParams | undefined;
    const client = makeStubClient(async (p) => {
      captured = p;
      return DUMMY_MSG;
    });

    const llm = createLlm(client, { model: 'claude-haiku-5-5', effort: 'low', fallbacks: false });
    await llm({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 });

    expect(captured?.betas).toBeUndefined();
    expect(captured?.fallbacks).toBeUndefined();
  });

  it('sets output_config.effort', async () => {
    let captured: LlmParams | undefined;
    const client = makeStubClient(async (p) => {
      captured = p;
      return DUMMY_MSG;
    });

    const llm = createLlm(client, { model: 'claude-haiku-5-5', effort: 'medium', fallbacks: false });
    await llm({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 });

    expect(captured?.output_config?.effort).toBe('medium');
  });

  it('maps NotFoundError to env-var hint', async () => {
    const client = makeStubClient(async () => {
      // Simulate the SDK throwing NotFoundError for an unknown model
      throw new Anthropic.NotFoundError(404, { error: { message: 'Model not found', type: 'not_found_error' } }, 'Model not found', new Headers());
    });

    const llm = createLlm(client, { model: 'bad-model', effort: 'low', fallbacks: false });
    await expect(llm({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }))
      .rejects.toThrow(/bad-model.*CALLER_MODEL/);
  });
});
