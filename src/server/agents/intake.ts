// Ruling R8: the intake system prompt lives here, not in agents/prompts.ts.
// Structured output follows the same pattern as src/server/interpret.ts
// (zod/v4 + SDK zodOutputFormat via output_config.format, call through LlmCall,
// validate the text with the same schema; any failure → clarifying question).
import { z } from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LlmCall, LlmParams } from '../llm.js';
import type { Clinic, Profile } from '../data.js';
import type { BookingRequest, TimeWindow } from '../../shared/types.js';
import { weekRange, weekdayOf } from '../dates.js';

// ---------------------------------------------------------------------------
// Structured output schema
// ---------------------------------------------------------------------------
const IntakeOutputSchema = z.object({
  /** Clinic id from the known list, or null if unidentified. */
  clinicId: z.string().nullable(),
  /** Specific service requested, or null. */
  service: z.string().nullable(),
  /** Earliest acceptable date YYYY-MM-DD, or null (defaults to next Monday). */
  dateFrom: z.string().nullable(),
  /** Latest acceptable date YYYY-MM-DD, or null (defaults to next Sunday). */
  dateTo: z.string().nullable(),
  /** "mornings", "afternoons", "HH:MM–HH:MM", or null for any time. */
  timeWindow: z.string().nullable(),
  /** Weekdays to avoid: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat. */
  excludedWeekdays: z.array(z.number().int().min(0).max(6)).nullable(),
  /** Extra patient notes, or null. */
  notes: z.string().nullable(),
  /** Question to ask if critical info is missing; null when ready to proceed. */
  clarifyingQuestion: z.string().nullable(),
  /** One-sentence summary of the booking request. */
  summary: z.string(),
});

type IntakeOutput = z.infer<typeof IntakeOutputSchema>;

// ---------------------------------------------------------------------------
// System prompt builder (R8: prompt lives inside this file)
// ---------------------------------------------------------------------------
// weekdayOf() returns 1=Mon…7=Sun; use directly for ISO name lookup.
const ISO_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function buildSystemPrompt(clinics: Clinic[], today: string): string {
  const isoDay = weekdayOf(today); // 1–7
  const weekdayName = ISO_NAMES[isoDay];
  const nw = weekRange(1, today);

  const clinicList = clinics
    .map(c => `  • id="${c.id}"  name="${c.name}"  service="${c.service}"`)
    .join('\n');

  return [
    'You are an AI assistant that extracts clinic booking details from spoken patient requests.',
    '',
    `Today is ${today} (${weekdayName}).`,
    `"Next week" means ${nw.from} (Mon) through ${nw.to} (Sun).`,
    '',
    'Available clinics:',
    clinicList,
    '',
    'Extract the booking details and return a JSON object with exactly these fields:',
    '  clinicId          – clinic id from the list above, or null if unknown',
    '  service           – requested service (e.g. "dental check-up"), or null',
    '  dateFrom          – earliest date YYYY-MM-DD, or null (defaults to next Monday)',
    '  dateTo            – latest date YYYY-MM-DD, or null (defaults to next Sunday)',
    '  timeWindow        – "mornings" (8am–12pm), "afternoons" (12pm–5pm),',
    '                      "HH:MM–HH:MM" for a custom range, or null for any time',
    '  excludedWeekdays  – weekdays to avoid as integers (0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat),',
    '                      or null',
    '  notes             – any extra info the patient mentioned, or null',
    '  clarifyingQuestion – one concise question if clinicId is null or critical info is missing,',
    '                       otherwise null',
    '  summary           – one sentence summarising the booking request',
    '',
    'Rules:',
    '  • Match clinic names case-insensitively; always use the id field from the list.',
    '  • If the clinic cannot be matched, set clinicId to null and provide a clarifyingQuestion.',
    '  • Never invent a clinic id — only use ids from the list above.',
    '  • If dates are not mentioned, leave them null.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Time-window string → TimeWindow object
// ---------------------------------------------------------------------------
function parseTimeWindow(tw: string | null): TimeWindow {
  if (tw === null) return { start: '08:00', end: '18:00' };
  const lower = tw.toLowerCase().trim();
  if (lower === 'mornings') return { start: '08:00', end: '12:00' };
  if (lower === 'afternoons') return { start: '12:00', end: '17:00' };
  // "HH:MM–HH:MM" or "HH:MM-HH:MM"
  const m = tw.match(/^(\d{2}:\d{2})[–\-](\d{2}:\d{2})$/);
  if (m) return { start: m[1], end: m[2] };
  return { start: '08:00', end: '18:00' };
}

// ---------------------------------------------------------------------------
// Intake class
// ---------------------------------------------------------------------------
export class Intake {
  private readonly clinics: Clinic[];
  private readonly profile: Profile;
  private readonly today: string;
  private readonly llm: LlmCall;
  /** Running conversation history (alternating user / assistant turns). */
  private readonly messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(clinics: Clinic[], profile: Profile, today: string, llm: LlmCall) {
    this.clinics = clinics;
    this.profile = profile;
    this.today = today;
    this.llm = llm;
  }

  async hear(
    text: string,
  ): Promise<
    { kind: 'question'; question: string } | { kind: 'ready'; request: BookingRequest; summary: string }
  > {
    // Append the new user turn to the running conversation history.
    this.messages.push({ role: 'user', content: text });

    // Build the structured-output format (same pattern as src/server/interpret.ts).
    const outputFormat = zodOutputFormat(IntakeOutputSchema);
    const format = outputFormat as unknown as NonNullable<
      NonNullable<LlmParams['output_config']>['format']
    >;

    const params: Omit<LlmParams, 'model'> = {
      max_tokens: 1024,
      output_config: { format },
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(this.clinics, this.today),
          // Prompt-caching: mark the stable system block so it can be reused.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: this.messages as unknown as LlmParams['messages'],
    };

    let raw: IntakeOutput;
    try {
      const msg = await this.llm(params);

      // Claude 5.5: check for refusal before reading content.
      if (msg.stop_reason === 'refusal') {
        return { kind: 'question', question: 'Sorry, could you say that again?' };
      }

      const textBlock = msg.content.find(
        (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
      );
      if (!textBlock) {
        return { kind: 'question', question: 'Sorry, could you say that again?' };
      }

      // Record the assistant reply so subsequent turns have full context.
      this.messages.push({ role: 'assistant', content: textBlock.text });

      let parsed: unknown;
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        return { kind: 'question', question: 'Sorry, could you say that again?' };
      }

      const result = IntakeOutputSchema.safeParse(parsed);
      if (!result.success) {
        return { kind: 'question', question: 'Sorry, could you say that again?' };
      }
      raw = result.data;
    } catch {
      return { kind: 'question', question: 'Sorry, could you say that again?' };
    }

    // Model-requested clarification takes priority over all other checks.
    if (raw.clarifyingQuestion !== null) {
      return { kind: 'question', question: raw.clarifyingQuestion };
    }

    // Validate clinicId against the known list; unknown id → treated as missing.
    const clinic = this.clinics.find(c => c.id === raw.clinicId);
    if (!clinic) {
      return { kind: 'question', question: 'Which clinic would you like to book at?' };
    }

    // Apply defaults for omitted date fields.
    const { from: defaultFrom, to: defaultTo } = weekRange(1, this.today);
    const dateFrom = raw.dateFrom ?? defaultFrom;
    const dateTo = raw.dateTo ?? defaultTo;

    // Code-side validation: reject past dates.
    if (dateFrom < this.today) {
      return {
        kind: 'question',
        question: 'The requested start date is in the past. Could you specify a future date?',
      };
    }

    // Code-side validation: dateFrom must not be after dateTo.
    if (dateFrom > dateTo) {
      return {
        kind: 'question',
        question: 'The start date must be before the end date. Could you clarify the dates?',
      };
    }

    // Apply remaining defaults.
    const timeWindow = parseTimeWindow(raw.timeWindow);
    const service = raw.service ?? clinic.service;
    const excludedWeekdays = raw.excludedWeekdays ?? [];

    const request: BookingRequest = {
      clinicId: clinic.id,
      service,
      patientName: this.profile.name,
      dateFrom,
      dateTo,
      timeWindow,
      excludedWeekdays,
      ...(raw.notes !== null ? { notes: raw.notes } : {}),
    };

    return { kind: 'ready', request, summary: raw.summary };
  }
}
