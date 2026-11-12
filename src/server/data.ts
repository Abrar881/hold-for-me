/**
 * Data-file loaders and TypeScript types for Hold For Me.
 *
 * JSON slot entries store a RelTime (weekOffset/weekday/time) so that data files
 * stay valid across days.  The loaders resolve them to concrete YYYY-MM-DDTHH:MM
 * strings before returning.
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRel } from './dates.js';
import type { CalendarEvent, Slot } from '../shared/types.js';

// ─── Exported types ────────────────────────────────────────────────────────────

export interface Profile {
  name: string;
  dob: string;
  phone: string;
  existingPatientAt: string[];
  /** Free-form extra fields (address etc.).  Never contains insuranceNumber. */
  fields: Record<string, string>;
}

export interface IvrNode {
  id: string;
  prompt: string;
  options: Record<string, string>;
  terminal?: 'hold' | 'receptionist' | 'closed';
}

export interface Clinic {
  id: string;
  name: string;
  service: string;
  receptionistName: string;
  persona: string;
  holdSeconds: number;
  ivr: IvrNode[];
  /** Slots in scripted offer order, with fully resolved start/end strings. */
  slots: Slot[];
  quirks: {
    asksDob?: boolean;
    newPatientFeeGbp?: number;
    requiresInfoForNewPatients?: string[];
  };
  demoRequest: string;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const RelTimeSchema = z.object({
  weekOffset: z.number().int(),
  weekday: z.number().int().min(1).max(7),
  time: z.string().regex(/^\d{2}:\d{2}$/),
});

const IvrNodeSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  options: z.record(z.string(), z.string()),
  terminal: z.enum(['hold', 'receptionist', 'closed']).optional(),
});

/** Array of IvrNodes with cross-reference validation. */
const IvrNodesSchema = z.array(IvrNodeSchema).superRefine((nodes, ctx) => {
  const ids = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    for (const [key, target] of Object.entries(node.options)) {
      if (!ids.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `IVR option "${key}" in node "${node.id}" points to missing node "${target}"`,
        });
      }
    }
  }
});

const ProfileSchema = z.object({
  name: z.string(),
  dob: z.string(),
  phone: z.string(),
  existingPatientAt: z.array(z.string()),
  fields: z.record(z.string(), z.string()),
});

/** Raw calendar-event entry in calendar.json (pre-resolution). */
const RawCalendarEventSchema = z.object({
  title: z.string(),
  start: RelTimeSchema,
  durationMin: z.number().int().positive(),
});

/** Raw slot entry in clinic JSON (pre-resolution). */
const RawSlotSchema = z.object({
  slotId: z.string(),
  rel: RelTimeSchema,
  durationMin: z.number().int().positive(),
});

/** Raw clinic file schema (slots stored as RelTime). */
const RawClinicSchema = z.object({
  id: z.string(),
  name: z.string(),
  service: z.string(),
  receptionistName: z.string(),
  persona: z.string(),
  holdSeconds: z.number().int().positive(),
  ivr: IvrNodesSchema,
  slots: z.array(RawSlotSchema),
  quirks: z.object({
    asksDob: z.boolean().optional(),
    newPatientFeeGbp: z.number().optional(),
    requiresInfoForNewPatients: z.array(z.string()).optional(),
  }),
  demoRequest: z.string(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Add `minutes` to a "YYYY-MM-DDTHH:MM" string. Does not cross midnight. */
function addMinutes(start: string, minutes: number): string {
  const [datePart, timePart] = start.split('T');
  const [h, m] = timePart.split(':').map(Number);
  const totalMins = h * 60 + m + minutes;
  const endH = Math.floor(totalMins / 60) % 24;
  const endM = totalMins % 60;
  return `${datePart}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

/** Read and parse a JSON file, throwing a descriptive error if invalid. */
function readJson(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

// ─── Loaders ──────────────────────────────────────────────────────────────────

/**
 * Load and validate the patient profile from `<dir>/profile.json`.
 * The `today` parameter is accepted for interface consistency but unused
 * (profile.json contains no relative dates).
 */
export function loadProfile(dir: string, _today: string): Profile {
  const filePath = path.join(dir, 'profile.json');
  const raw = readJson(filePath);
  return ProfileSchema.parse(raw);
}

/**
 * Load and resolve calendar events from `<dir>/calendar.json`.
 * Relative dates are resolved against `today` (YYYY-MM-DD).
 */
export function loadCalendar(dir: string, today: string): CalendarEvent[] {
  const filePath = path.join(dir, 'calendar.json');
  const raw = readJson(filePath) as unknown[];
  const entries = z.array(RawCalendarEventSchema).parse(raw);
  return entries.map(e => {
    const start = resolveRel(e.start, today);
    const end = addMinutes(start, e.durationMin);
    return { title: e.title, start, end };
  });
}

/**
 * Load and resolve all clinic JSON files in `dir`.
 * Slots are resolved from RelTime to concrete Slot objects.
 */
export function loadClinics(dir: string, today: string): Clinic[] {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.map(file => {
    const filePath = path.join(dir, file);
    const raw = readJson(filePath);
    const parsed = RawClinicSchema.parse(raw);
    const slots: Slot[] = parsed.slots.map(s => {
      const start = resolveRel(s.rel, today);
      const end = addMinutes(start, s.durationMin);
      return { slotId: s.slotId, start, end };
    });
    return { ...parsed, slots };
  });
}
