/**
 * DTMF (Dual-Tone Multi-Frequency) frequency table.
 *
 *         1209 Hz   1336 Hz   1477 Hz
 *  697 Hz    1         2         3
 *  770 Hz    4         5         6
 *  852 Hz    7         8         9
 *  941 Hz    *         0         #
 */
const DTMF_TABLE: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

/** Return [rowFreq, colFreq] for a DTMF digit. Throws for unknown digits. */
export function dtmfFreqs(digit: string): [number, number] {
  const freqs = DTMF_TABLE[digit];
  if (!freqs) {
    throw new Error(`Unknown DTMF digit: ${JSON.stringify(digit)}`);
  }
  return freqs;
}

/** Play a DTMF tone via WebAudio for `durationMs` milliseconds. */
export function playDtmfTone(
  ctx: AudioContext,
  digit: string,
  durationMs = 120,
  gainValue = 0.3,
): void {
  const [f1, f2] = dtmfFreqs(digit);
  const gain = ctx.createGain();
  gain.gain.value = gainValue;
  gain.connect(ctx.destination);

  const osc1 = ctx.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.value = f1;
  osc1.connect(gain);

  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = f2;
  osc2.connect(gain);

  const start = ctx.currentTime;
  const end = start + durationMs / 1000;

  osc1.start(start);
  osc1.stop(end);
  osc2.start(start);
  osc2.stop(end);
}
