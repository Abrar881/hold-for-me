// The SDK's zodOutputFormat requires Zod v4 schema objects (uses _zod.def
// internally). The project ships zod 3.x which bundles a v4 compat layer at
// the "zod/v4" subpath — import from there so the schemas are compatible.
import { z } from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LlmCall, LlmParams } from './llm.js';

// ---------------------------------------------------------------------------
// Zod schema for the LLM-structured decision
// ---------------------------------------------------------------------------

const DecisionSchema = z.object({
  decision: z.enum(['yes', 'no', 'unclear']),
  note: z.string(),
});

type Decision = z.infer<typeof DecisionSchema>;

// ---------------------------------------------------------------------------
// Regex fast paths — evaluated before the LLM call
// ---------------------------------------------------------------------------

const YES_RE = /^(yes|yeah|yep|sure|ok(ay)?|fine|that'?s fine|go ahead|book it)\b/i;
const NO_RE = /^(no|nope|don'?t|not)\b/i;

/** Words that carry no information beyond agreement ("yes please", "ok, go ahead"). */
const AGREEMENT_WORDS_RE =
  /\b(yes|yeah|yep|sure|ok(ay)?|fine|that'?s fine|go ahead|book it|please|thanks|thank you)\b/gi;

/** True when the answer opens with a clear "no" (the same fast path interpretAnswer uses). */
export function isClearNo(answer: string): boolean {
  return NO_RE.test(answer.trim());
}

/**
 * True when the answer says more than a bare agreement: "yes please" → false,
 * "yes, my insurance number is RX-1234" → true.
 */
export function hasContentBeyondYes(answer: string): boolean {
  return answer.replace(AGREEMENT_WORDS_RE, '').replace(/[^\p{L}\p{N}]+/gu, '').length > 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a user utterance as yes / no / unclear given the question that was
 * asked.  Uses regex fast-paths for unambiguous answers; falls back to the LLM
 * with a structured-output schema for anything ambiguous.
 *
 * Always resolves — never rejects.  Any LLM failure or bad JSON → unclear.
 */
export async function interpretAnswer(
  answer: string,
  question: string,
  llm: LlmCall,
): Promise<{ decision: 'yes' | 'no' | 'unclear'; note: string }> {
  const trimmed = answer.trim();

  // Empty input — unclear without calling the LLM
  if (trimmed.length === 0) {
    return { decision: 'unclear', note: '' };
  }

  // Yes fast path
  if (YES_RE.test(trimmed)) {
    return { decision: 'yes', note: trimmed };
  }

  // No fast path
  if (NO_RE.test(trimmed)) {
    return { decision: 'no', note: trimmed };
  }

  // Ambiguous — ask the LLM
  return callLlm(answer, question, llm);
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------

async function callLlm(
  answer: string,
  question: string,
  llm: LlmCall,
): Promise<{ decision: 'yes' | 'no' | 'unclear'; note: string }> {
  const outputFormat = zodOutputFormat(DecisionSchema);

  // BetaOutputConfig.format expects BetaJSONOutputFormat; zodOutputFormat
  // returns AutoParseableOutputFormat which is structurally identical
  // ({type:'json_schema', schema:{...}}) but typed differently.
  const format = outputFormat as unknown as NonNullable<
    NonNullable<LlmParams['output_config']>['format']
  >;

  const params: Omit<LlmParams, 'model'> = {
    max_tokens: 256,
    output_config: { format },
    system: [
      {
        type: 'text',
        text: [
          'You are classifying a spoken user response.',
          'Return JSON matching the schema: { decision: "yes"|"no"|"unclear", note: string }.',
          '"yes" = the user clearly accepts/approves.',
          '"no"  = the user clearly declines/rejects.',
          '"unclear" = ambiguous, needs clarification.',
          '"note" should be a short string explaining why, or echo the original text for yes/no.',
        ].join('\n'),
        // prompt-caching: mark the stable system block so it can be cached
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Question asked: "${question}"\nUser said: "${answer}"\n\nClassify the response.`,
      },
    ],
  };

  try {
    const msg = await llm(params);

    // Global constraint: check stop_reason before reading content
    if (msg.stop_reason === 'refusal') {
      return { decision: 'unclear', note: answer };
    }

    // Extract text from the first text block
    const textBlock = msg.content.find(
      (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
    );
    if (!textBlock) {
      return { decision: 'unclear', note: answer };
    }

    // Validate the returned JSON against the schema
    let raw: unknown;
    try {
      raw = JSON.parse(textBlock.text);
    } catch {
      return { decision: 'unclear', note: answer };
    }

    const parsed = DecisionSchema.safeParse(raw);
    if (!parsed.success) {
      return { decision: 'unclear', note: answer };
    }

    return parsed.data;
  } catch {
    return { decision: 'unclear', note: answer };
  }
}
