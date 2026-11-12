import { describe, it, expect } from 'vitest';
import { vadShouldStop } from '../../src/web/recorder.js';

describe('vadShouldStop', () => {
  it('no speech yet → false even after long silence', () => {
    // 2 seconds of silence, never crossed speechRms threshold
    const samples = Array.from({ length: 40 }, (_, i) => ({ t: i * 50, rms: 0.001 }));
    expect(vadShouldStop(samples)).toBe(false);
  });

  it('speech then 1200ms silence → true', () => {
    // Speech at t=0 (rms above threshold), then silence from t=200
    const samples: { t: number; rms: number }[] = [
      { t: 0,    rms: 0.05 }, // speech
      { t: 50,   rms: 0.04 }, // speech
      { t: 100,  rms: 0.03 }, // speech
      { t: 150,  rms: 0.025 }, // speech
      { t: 200,  rms: 0.001 }, // silence starts
      { t: 250,  rms: 0.001 },
      { t: 300,  rms: 0.001 },
      { t: 350,  rms: 0.001 },
      { t: 400,  rms: 0.001 },
      { t: 450,  rms: 0.001 },
      { t: 500,  rms: 0.001 },
      { t: 550,  rms: 0.001 },
      { t: 600,  rms: 0.001 },
      { t: 650,  rms: 0.001 },
      { t: 700,  rms: 0.001 },
      { t: 750,  rms: 0.001 },
      { t: 800,  rms: 0.001 },
      { t: 850,  rms: 0.001 },
      { t: 900,  rms: 0.001 },
      { t: 950,  rms: 0.001 },
      { t: 1000, rms: 0.001 },
      { t: 1050, rms: 0.001 },
      { t: 1100, rms: 0.001 },
      { t: 1150, rms: 0.001 },
      { t: 1200, rms: 0.001 }, // silence has lasted 1000ms (from t=200 to t=1200)
      { t: 1250, rms: 0.001 },
      { t: 1300, rms: 0.001 },
      { t: 1350, rms: 0.001 },
      { t: 1400, rms: 0.001 }, // silence has lasted 1200ms exactly
    ];
    expect(vadShouldStop(samples)).toBe(true);
  });

  it('speech then 800ms silence → false', () => {
    const samples: { t: number; rms: number }[] = [
      { t: 0,   rms: 0.05 }, // speech
      { t: 50,  rms: 0.04 }, // speech
      { t: 100, rms: 0.001 }, // silence starts
      { t: 150, rms: 0.001 },
      { t: 200, rms: 0.001 },
      { t: 250, rms: 0.001 },
      { t: 300, rms: 0.001 },
      { t: 350, rms: 0.001 },
      { t: 400, rms: 0.001 },
      { t: 450, rms: 0.001 },
      { t: 500, rms: 0.001 },
      { t: 550, rms: 0.001 },
      { t: 600, rms: 0.001 },
      { t: 650, rms: 0.001 },
      { t: 700, rms: 0.001 },
      { t: 750, rms: 0.001 },
      { t: 800, rms: 0.001 },
      { t: 850, rms: 0.001 },
      { t: 900, rms: 0.001 }, // silence has lasted 800ms (from t=100 to t=900)
    ];
    expect(vadShouldStop(samples)).toBe(false);
  });
});
