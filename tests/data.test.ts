import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProfile, loadCalendar, loadClinics } from '../src/server/data.js';

const TODAY = '2026-11-12'; // Thursday

describe('loadProfile', () => {
  it('loads the profile correctly', () => {
    const profile = loadProfile('data', TODAY);
    expect(profile.name).toBe('Alex Khan');
    expect(profile.dob).toBe('1998-04-03');
    expect(profile.phone).toBe('07700 900123');
    expect(profile.existingPatientAt).toContain('bright-smile');
  });

  it('profile has no insuranceNumber field', () => {
    const profile = loadProfile('data', TODAY);
    expect(profile.fields).not.toHaveProperty('insuranceNumber');
  });
});

describe('loadCalendar', () => {
  it('calendar resolves stand-up to 2026-11-17T09:00–10:00', () => {
    const events = loadCalendar('data', TODAY);
    const standUp = events.find(e => e.title === 'Team stand-up');
    expect(standUp?.start).toBe('2026-11-17T09:00');
    expect(standUp?.end).toBe('2026-11-17T10:00');
  });
});

describe('loadClinics', () => {
  it('loads three clinics with resolved slots', () => {
    const clinics = loadClinics('data/clinics', TODAY);
    expect(clinics).toHaveLength(3);

    const bs = clinics.find(c => c.id === 'bright-smile');
    expect(bs).toBeDefined();
    expect(bs!.slots[0].start).toBe('2026-11-17T09:00');
    expect(bs!.slots[0].end).toBe('2026-11-17T09:30');
    expect(bs!.slots[0].slotId).toBe('bs-1');
  });

  it('rejects a clinic whose IVR option points to a missing node', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiya-test-'));
    try {
      const badClinic = {
        id: 'bad',
        name: 'Bad Clinic',
        service: 'dental',
        receptionistName: 'Bob',
        persona: 'test',
        holdSeconds: 5,
        ivr: [
          {
            id: 'root',
            prompt: 'Press 1',
            options: { '1': 'nonexistent-node' },
          },
        ],
        slots: [],
        quirks: {},
        demoRequest: 'Test',
      };
      fs.writeFileSync(path.join(tmpDir, 'bad.json'), JSON.stringify(badClinic));
      expect(() => loadClinics(tmpDir, TODAY)).toThrow(/missing node/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
