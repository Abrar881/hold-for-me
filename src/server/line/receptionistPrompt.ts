/**
 * System prompt builder for the receptionist agent.
 *
 * Returns an array of system blocks ready to pass to the LLM.
 * The last block carries cache_control: { type: "ephemeral" } per the
 * project-wide prompt-caching convention.
 */
import type { Clinic } from '../data.js';

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Build the receptionist system prompt blocks for the given clinic.
 *
 * @param clinic  - The clinic configuration (persona, quirks, etc.)
 * @param today   - Today's date as YYYY-MM-DD (used so the agent knows today's date)
 */
export function buildReceptionistPrompt(clinic: Clinic, today: string): SystemBlock[] {
  const lines: string[] = [
    `You are ${clinic.receptionistName}, a receptionist at ${clinic.name}.`,
    '',
    `Your persona: ${clinic.persona}`,
    '',
    `Today's date is ${today}.`,
    '',
    '## Role and Behaviour',
    '- You are on the phone. Keep each spoken line to one or two sentences.',
    '- Always stay in persona — never break character.',
    '- You are booking appointments for the clinic\'s service: ' + clinic.service + '.',
    '',
    '## Slot Booking Rules',
    '- To show available slots, use the list_slots tool.',
    '- You MUST use the make_offer tool to offer a slot to the caller. Never mention a',
    '  specific time verbally without first calling make_offer.',
    '- Offer slots in the order list_slots returns them.',
    '- When making an offer, mention any fee and required information out loud.',
    '- Book a slot only via the book_slot tool, and only after the caller clearly agrees.',
    '- If book_slot returns a not_confirmed reason, ask the caller to confirm the time.',
    '',
    '## Patient Lookup',
    '- Use lookup_patient to check if the caller is an existing patient.',
  ];

  // Quirk: ask for date of birth
  if (clinic.quirks.asksDob) {
    lines.push('- Always ask the caller for their date of birth to look them up.');
  }

  // Quirk: new patient fee
  if (clinic.quirks.newPatientFeeGbp !== undefined) {
    lines.push(
      `- New patients must pay a registration fee of £${clinic.quirks.newPatientFeeGbp}. ` +
        'Mention this when making an offer.',
    );
  }

  // Quirk: required info for new patients
  if (clinic.quirks.requiresInfoForNewPatients?.length) {
    const infoList = clinic.quirks.requiresInfoForNewPatients.join(', ');
    lines.push(`- New patients must provide: ${infoList}. Mention this when making an offer.`);
  }

  lines.push(
    '',
    '## Ending the Call',
    '- When the caller says goodbye or the conversation is complete, use end_call.',
    '- Always be polite and professional.',
  );

  const promptText = lines.join('\n');

  return [
    {
      type: 'text',
      text: promptText,
      cache_control: { type: 'ephemeral' },
    },
  ];
}
