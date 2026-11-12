/**
 * Caller-agent tool definitions and local executors.
 *
 * callerToolDefs — the 9 tools to pass to the LLM (strict JSON schema).
 * execLocal      — runs tools that do not require line/user interaction;
 *                  returns null for press_keys, say, wait, ask_user, end_call.
 * CallState      — mutable state threaded through the caller agent loop.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { BookingRequest, Offer, CalendarEvent, Approval } from '../../shared/types.js';
import type { Profile } from '../data.js';
import type { SlotBook } from '../line/slotBook.js';
import { GateResult } from '../../shared/types.js';
import { evaluateOffer } from '../gate.js';
import { busyBetween } from '../calendar.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CallState {
  request: BookingRequest;
  profile: Profile;
  calendar: CalendarEvent[];
  approvals: Approval[];
  /** Offers the caller has heard about (offerId → Offer). */
  offers: Map<string, Offer>;
  userAnswers: { field?: string; text: string }[];
}

/** Return type alias for callerToolDefs to allow cast-free access to strict. */
export type CallerToolDef = Anthropic.Beta.Messages.BetaTool;

// ─── Tool definitions ────────────────────────────────────────────────────────

export const callerToolDefs: CallerToolDef[] = [
  {
    name: 'press_keys',
    description: 'Press DTMF digits on the phone keypad (e.g. for IVR menus).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        digits: { type: 'string', description: 'Digit(s) to press, e.g. "1" or "23".' },
      },
      required: ['digits'],
      additionalProperties: false,
    },
  },
  {
    name: 'say',
    description: 'Speak text aloud to the receptionist or IVR.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description: 'Wait silently (e.g. while on hold).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'check_calendar',
    description: 'Return calendar events whose start date falls within [from, to] inclusive.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date inclusive (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD).' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_profile_field',
    description:
      "Return a field from the patient's profile. Returns an error if the field is absent.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Field name (e.g. "name", "dob", "address").' },
      },
      required: ['field'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the patient a question out-of-band. Use when approval or missing info is needed. ' +
      'Always say "One moment please, let me check with <first name>." before calling this.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to present to the patient.' },
        offerId: {
          type: 'string',
          description: 'The offerId this question relates to, if any.',
        },
        approvalFor: {
          type: 'array',
          items: { type: 'string', enum: ['slot', 'fee'] },
          description: 'Which approvals this question seeks.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'accept_offer',
    description:
      'Run the booking gate and, if it passes, mark the offer accepted in the system. ' +
      'Must be called before verbally accepting any offer.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'The offer ID to accept.' },
      },
      required: ['offerId'],
      additionalProperties: false,
    },
  },
  {
    name: 'provide_info',
    description:
      'Provide a required piece of information for an offer. ' +
      'source="profile" reads it from the profile; source="user" uses a recorded user answer.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'The offer ID this info is for.' },
        field: { type: 'string', description: 'The info field name.' },
        source: {
          type: 'string',
          enum: ['profile', 'user'],
          description: 'Where to source the value from.',
        },
      },
      required: ['offerId', 'field', 'source'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_call',
    description: 'End the call and report the outcome.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['booked', 'not_booked'],
          description: 'Whether a booking was made.',
        },
        summary: { type: 'string', description: 'Short summary of what happened.' },
      },
      required: ['outcome', 'summary'],
      additionalProperties: false,
    },
  },
];

// ─── Local executor ──────────────────────────────────────────────────────────

type ExecResult = {
  content: string;
  isError?: boolean;
  offerEvent?: { offer: Offer; gate: GateResult };
} | null;

/**
 * Execute a tool locally.  Returns null for tools that require line or user
 * interaction (press_keys, say, wait, ask_user, end_call) — the caller agent
 * loop handles those.
 */
export function execLocal(
  name: string,
  input: Record<string, unknown>,
  state: CallState,
  book: SlotBook,
): ExecResult {
  switch (name) {
    // ── Line / user tools — handled externally ───────────────────────────
    case 'press_keys':
    case 'say':
    case 'wait':
    case 'ask_user':
    case 'end_call':
      return null;

    // ── check_calendar ───────────────────────────────────────────────────
    case 'check_calendar': {
      const from = input['from'] as string;
      const to = input['to'] as string;
      const busy = busyBetween(state.calendar, from, to);
      return { content: JSON.stringify(busy) };
    }

    // ── get_profile_field ────────────────────────────────────────────────
    case 'get_profile_field': {
      const field = input['field'] as string;
      const profile = state.profile;

      // Check top-level profile fields (name, dob, phone, existingPatientAt)
      if (field in profile && field !== 'fields') {
        const value = (profile as Record<string, unknown>)[field];
        return { content: String(value) };
      }

      // Check extra fields
      if (field in profile.fields) {
        return { content: profile.fields[field] };
      }

      return {
        content:
          'Not on file. Use ask_user to get it from Alex; never guess.',
        isError: true,
      };
    }

    // ── accept_offer ─────────────────────────────────────────────────────
    case 'accept_offer': {
      const offerId = input['offerId'] as string;
      const offer = book.getOffer(offerId);
      const gate = evaluateOffer(offer, state.request, state.calendar, state.approvals);

      if (!gate.ok) {
        const reasons = gate.reasons.join(', ');
        return {
          content: `Gate failed: ${reasons}. Do not accept. Decline politely or use ask_user with offerId and approvalFor.`,
          isError: true,
          offerEvent: offer ? { offer, gate } : undefined,
        };
      }

      // Gate passed — mark accepted
      book.markAccepted(offerId);

      // Acknowledge fee if a fee approval was present
      const hasFeeApproval = state.approvals.some(
        a => a.offerId === offerId && a.kinds.includes('fee'),
      );
      if (hasFeeApproval) {
        book.acknowledgeFee(offerId);
      }

      return {
        content: 'Accepted in system. Now tell the receptionist clearly that you accept.',
        offerEvent: { offer: offer!, gate },
      };
    }

    // ── provide_info ─────────────────────────────────────────────────────
    case 'provide_info': {
      const offerId = input['offerId'] as string;
      const field = input['field'] as string;
      const source = input['source'] as 'profile' | 'user';

      if (source === 'profile') {
        const profile = state.profile;
        const hasField =
          (field in profile && field !== 'fields') || field in profile.fields;
        if (!hasField) {
          return {
            content: `Field "${field}" is not in the profile. Use source="user" and ask_user to get it.`,
            isError: true,
          };
        }
      } else {
        // source === 'user'
        const hasAnswer = state.userAnswers.some(a => a.field === field);
        if (!hasAnswer) {
          return {
            content: `No recorded user answer for field "${field}". Use ask_user first.`,
            isError: true,
          };
        }
      }

      book.provideInfo(offerId, field);
      return { content: `Provided "${field}" for offer ${offerId}.` };
    }

    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
}
