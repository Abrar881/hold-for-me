/**
 * Receptionist agent for Hold For Me.
 *
 * Runs a manual tool loop (max 6 iterations) over a scripted SlotBook,
 * consuming an LlmCall provided by the caller — no LLM configuration here.
 */
import type { LlmCall, LlmParams, LlmMessage } from '../llm.js';
import type { Clinic, Profile } from '../data.js';
import type { Offer, Booking } from '../../shared/types.js';
import { SlotBook } from './slotBook.js';
import { buildReceptionistPrompt } from './receptionistPrompt.js';
import type Anthropic from '@anthropic-ai/sdk';

// ─── Tool definitions ─────────────────────────────────────────────────────────

type BetaTool = NonNullable<LlmParams['tools']>[number];

const TOOLS: BetaTool[] = [
  {
    name: 'list_slots',
    description: 'List available appointment slots in a date range.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Start date inclusive (YYYY-MM-DD)' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD)' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'make_offer',
    description: 'Create an offer for a specific slot. Call this before verbally offering any time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slotId: { type: 'string', description: 'The slot ID from list_slots' },
      },
      required: ['slotId'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'book_slot',
    description: 'Book a slot using an offer ID, after the caller has clearly agreed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        offerId: { type: 'string', description: 'The offer ID from make_offer' },
      },
      required: ['offerId'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'lookup_patient',
    description: 'Look up whether the caller is an existing patient.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Patient full name' },
        dob: { type: 'string', description: 'Date of birth (YYYY-MM-DD)' },
      },
      required: ['name', 'dob'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'end_call',
    description: 'End the call when the conversation is complete.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface RespondResult {
  text: string;
  offer?: Offer;
  booking?: Booking;
  hungUp: boolean;
}

// ─── Receptionist class ───────────────────────────────────────────────────────

const MAX_ITERATIONS = 6;
const FALLBACK_LINE = "I'm sorry, I'm having trouble processing your request right now. Please try calling back.";
const REFUSAL_LINE = "I'm sorry, I'm unable to help with that. Goodbye.";

export class Receptionist {
  private readonly clinic: Clinic;
  private readonly book: SlotBook;
  private readonly profile: Profile;
  private readonly llm: LlmCall;
  private readonly today: string;
  private readonly history: MessageParam[] = [];

  constructor(
    clinic: Clinic,
    book: SlotBook,
    profile: Profile,
    llm: LlmCall,
    /** Today's date as YYYY-MM-DD. Defaults to current system date. */
    today?: string,
  ) {
    this.clinic = clinic;
    this.book = book;
    this.profile = profile;
    this.llm = llm;
    this.today = today ?? new Date().toISOString().slice(0, 10);
  }

  /** Returns the fixed greeting line without calling the LLM. */
  greet(): string {
    return `${this.clinic.name}, ${this.clinic.receptionistName} speaking, how can I help?`;
  }

  /**
   * Process a caller utterance through the tool loop.
   *
   * Conversation history persists across calls on this Receptionist instance.
   */
  async respond(
    callerText: string,
    signal?: AbortSignal,
  ): Promise<RespondResult> {
    // Append caller turn to history
    this.history.push({ role: 'user', content: callerText });

    const system = buildReceptionistPrompt(this.clinic, this.today);

    let lastText = '';
    let resultOffer: Offer | undefined;
    let resultBooking: Booking | undefined;
    let hungUp = false;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const params: Omit<LlmParams, 'model'> = {
        max_tokens: 1024,
        system,
        tools: TOOLS,
        tool_choice: { type: 'auto' } as NonNullable<LlmParams['tool_choice']>,
        messages: [...this.history],
      };

      const msg = await this.llm(params, signal);

      // Handle refusal
      if (msg.stop_reason === 'refusal') {
        // Append the assistant turn so history is consistent
        // msg.content (response blocks) is structurally compatible with request content
        this.history.push({
          role: 'assistant',
          content: msg.content as unknown as Anthropic.Beta.Messages.BetaMessageParam['content'],
        } as MessageParam);
        return {
          text: REFUSAL_LINE,
          offer: resultOffer,
          booking: resultBooking,
          hungUp: true,
        };
      }

      // Extract text and tool_use blocks from content
      let assistantText = '';
      const toolUseBlocks: ToolUseBlock[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          assistantText += block.text;
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block as ToolUseBlock);
        }
      }

      if (assistantText) {
        lastText = assistantText;
      }

      // Append assistant turn to history
      // msg.content (response blocks) is structurally compatible with request content
      this.history.push({
        role: 'assistant',
        content: msg.content as unknown as Anthropic.Beta.Messages.BetaMessageParam['content'],
      } as MessageParam);

      // If no tools were called, we're done
      if (msg.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
        break;
      }

      // Execute all tools, collect results
      const toolResults: ToolResultBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        const { id, name, input } = toolUse;
        const toolResult = this.executeTool(name, input);

        // Check for end_call
        if (name === 'end_call') {
          hungUp = true;
        }

        // Check for make_offer result to surface as structured offer
        if (name === 'make_offer' && toolResult.ok) {
          const offerResult = toolResult.value as Offer;
          if ('offerId' in offerResult) {
            resultOffer = offerResult;
          }
        }

        // Check for book_slot result to surface as booking
        if (name === 'book_slot' && toolResult.ok) {
          // executeTool returns the Booking directly when booking succeeds
          resultBooking = toolResult.value as Booking;
        }

        if (toolResult.ok) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: JSON.stringify(toolResult.value),
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: toolResult.error,
            is_error: true,
          });
        }
      }

      // Return all tool results in one user message
      this.history.push({
        role: 'user',
        content: toolResults as unknown as Anthropic.Beta.Messages.BetaMessageParam['content'],
      } as MessageParam);
    }

    return {
      text: lastText || FALLBACK_LINE,
      offer: resultOffer,
      booking: resultBooking,
      hungUp,
    };
  }

  // ─── Tool executor ─────────────────────────────────────────────────────────

  private executeTool(
    name: string,
    input: Record<string, unknown>,
  ): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
      switch (name) {
        case 'list_slots': {
          const { from, to } = input as { from: string; to: string };
          const slots = this.book.list(from, to);
          return { ok: true, value: slots };
        }

        case 'make_offer': {
          const { slotId } = input as { slotId: string };
          const result = this.book.makeOffer(slotId);
          if ('error' in result) {
            return { ok: false, error: result.error };
          }
          return { ok: true, value: result };
        }

        case 'book_slot': {
          const { offerId } = input as { offerId: string };
          // Get the offer to find patient name
          const offer = this.book.getOffer(offerId);
          if (!offer) {
            return { ok: false, error: `Unknown offer: ${offerId}` };
          }
          const result = this.book.book(offerId, this.profile.name);
          if (!result.ok) {
            return { ok: false, error: `Booking failed: ${result.reason}` };
          }
          return { ok: true, value: result.booking };
        }

        case 'lookup_patient': {
          const { name: patientName, dob } = input as { name: string; dob: string };
          const isExisting = this.profile.existingPatientAt.includes(this.clinic.id);
          return {
            ok: true,
            value: {
              status: isExisting ? 'existing' : 'new',
              name: patientName,
              dob,
            },
          };
        }

        case 'end_call': {
          return { ok: true, value: { ended: true } };
        }

        default: {
          return { ok: false, error: `Unknown tool: ${name}` };
        }
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}
