import Anthropic from '@anthropic-ai/sdk';

/** Full non-streaming params for the beta messages endpoint. */
export type LlmParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** Response type from the beta messages endpoint. */
export type LlmMessage = Anthropic.Beta.Messages.BetaMessage;

/**
 * A configured LLM caller. Accepts everything except `model`
 * (injected by createLlm) and an optional AbortSignal.
 */
export type LlmCall = (
  p: Omit<LlmParams, 'model'>,
  signal?: AbortSignal,
) => Promise<LlmMessage>;

/**
 * Build a bound LlmCall for a specific model and effort level.
 *
 * When `fallbacks` is true the caller-agent variant is configured:
 * beta `server-side-fallback-2026-07-01` + `fallbacks: "default"`.
 */
export function createLlm(
  client: Anthropic,
  opts: { model: string; effort: 'low' | 'medium' | 'high'; fallbacks: boolean },
): LlmCall {
  return async (p, signal) => {
    const baseBetas: string[] = Array.isArray(p.betas) ? [...p.betas] : [];
    const fallbackBetas: string[] = opts.fallbacks
      ? ['server-side-fallback-2026-07-01']
      : [];

    const params: LlmParams = {
      ...p,
      model: opts.model,
      output_config: {
        effort: opts.effort,
        ...p.output_config,
      },
      ...(opts.fallbacks
        ? {
            betas: [...baseBetas, ...fallbackBetas],
            // `fallbacks: "default"` is in BetaFallbacksParam since SDK 1.x
            fallbacks: 'default',
          }
        : baseBetas.length > 0
          ? { betas: baseBetas }
          : {}),
    };

    try {
      return await client.beta.messages.create(params, { signal });
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError) {
        throw new Error(
          `Model '${opts.model}' not found — set CALLER_MODEL/RECEPTIONIST_MODEL/INTERPRET_MODEL in .env`,
        );
      }
      throw err;
    }
  };
}
