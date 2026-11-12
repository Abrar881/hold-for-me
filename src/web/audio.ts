import type { ClientMsg } from '../shared/protocol.js';
import { playDtmfTone } from './tones.js';

type SpeechMode = 'openai' | 'browser';

interface QueuedUtterance {
  id: string;
  speaker: string;
  text: string;
  channel: 'call' | 'user';
  audioB64?: string;
  mime?: string;
  speechMode: SpeechMode;
}

/** Lazy-create a shared AudioContext (browser requires a user gesture first). */
let sharedCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
  }
  if (sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => undefined);
  }
  return sharedCtx;
}

/** Map speaker names to SpeechSynthesis voices, so they sound distinct. */
const VOICE_PREFS: Record<string, string[]> = {
  agent:        ['Google UK English Male', 'Daniel', 'en-GB'],
  receptionist: ['Google UK English Female', 'Samantha', 'en-US'],
  ivr:          ['Google US English', 'Alex', 'en'],
  user:         ['Fiona', 'Google US English', 'en'],
  assistant:    ['Google UK English Male', 'Daniel', 'en-GB'],
};

function pickVoice(speaker: string): SpeechSynthesisVoice | null {
  const prefs = VOICE_PREFS[speaker] ?? VOICE_PREFS.receptionist;
  const voices = speechSynthesis.getVoices();
  for (const pref of prefs) {
    const v = voices.find(v => v.name.includes(pref) || v.lang.startsWith(pref));
    if (v) return v;
  }
  return voices[0] ?? null;
}

/** Arpeggio note sequence for hold music: Cmaj pentatonic */
const ARPEGGIO_FREQS = [261.6, 329.6, 392.0, 523.3, 392.0, 329.6];

/**
 * Player: queues utterances and plays them one after another.
 * Sends `played` messages via the provided callback after each.
 * Respects listen-in state: call-channel audio is skipped (acked immediately)
 * when listenIn is false; user-channel always plays.
 */
export class Player {
  private queue: QueuedUtterance[] = [];
  private busy = false;
  private listenIn = true;
  private holdInterval: ReturnType<typeof setTimeout> | null = null;
  private holdOscillators: OscillatorNode[] = [];
  private holdGain: GainNode | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private idleCallbacks = new Set<() => void>();

  constructor(private send: (msg: ClientMsg) => void) {}

  /**
   * Register a callback fired whenever the queue empties (the Player becomes idle).
   * Returns an unsubscribe function.
   */
  onIdle(cb: () => void): () => void {
    this.idleCallbacks.add(cb);
    return () => this.idleCallbacks.delete(cb);
  }

  /** True when no items are queued and nothing is playing. */
  get idle(): boolean {
    return !this.busy && this.queue.length === 0;
  }

  setListenIn(on: boolean): void {
    this.listenIn = on;
  }

  /** Enqueue an utterance for playback. */
  enqueue(item: QueuedUtterance): void {
    this.queue.push(item);
    if (!this.busy) {
      void this.drain();
    }
  }

  /** Play a notification chime (two ascending tones). */
  playChime(): void {
    const ctx = getAudioContext();
    [[880, 0], [1100, 0.18]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0.25;
      gain.gain.setTargetAtTime(0, ctx.currentTime + delay + 0.15, 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.4);
    });
  }

  /** Play DTMF digits (each digit separately). */
  playDigits(digits: string): void {
    const ctx = getAudioContext();
    digits.split('').forEach((d, i) => {
      setTimeout(() => {
        try { playDtmfTone(ctx, d); } catch { /* ignore unknown */ }
      }, i * 200);
    });
  }

  /** Start looping hold music (simple arpeggio). */
  startHoldMusic(): void {
    this.stopHoldMusic();
    const ctx = getAudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0.08;
    gain.connect(ctx.destination);
    this.holdGain = gain;

    let noteIndex = 0;
    const scheduleNote = () => {
      if (!this.holdGain) return;
      const freq = ARPEGGIO_FREQS[noteIndex % ARPEGGIO_FREQS.length];
      noteIndex++;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.connect(gain);
      const now = ctx.currentTime;
      osc.start(now);
      osc.stop(now + 0.3);
      this.holdOscillators.push(osc);
      // Remove from tracking once the oscillator has fully ended.
      osc.onended = () => {
        this.holdOscillators = this.holdOscillators.filter(o => o !== osc);
      };
    };

    scheduleNote();
    this.holdInterval = setInterval(scheduleNote, 400);
  }

  stopHoldMusic(): void {
    if (this.holdInterval !== null) {
      clearInterval(this.holdInterval);
      this.holdInterval = null;
    }
    if (this.holdGain) {
      try {
        this.holdGain.gain.setTargetAtTime(0, getAudioContext().currentTime, 0.1);
      } catch { /* ignore */ }
      this.holdGain = null;
    }
    this.holdOscillators = [];
  }

  /** Stop everything immediately. */
  stop(): void {
    this.queue = [];
    this.busy = false;
    this.stopHoldMusic();
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    if (this.currentUtterance) {
      speechSynthesis.cancel();
      this.currentUtterance = null;
    }
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await this.playItem(item);
      } catch {
        // If playback fails, still acknowledge so the server keeps moving.
      }
      this.send({ type: 'played', id: item.id });
    }
    this.busy = false;
    // Notify listeners that the queue is now empty.
    for (const cb of this.idleCallbacks) cb();
  }

  private async playItem(item: QueuedUtterance): Promise<void> {
    // Call-channel audio is skipped (acked immediately) when listening in is off.
    if (item.channel === 'call' && !this.listenIn) {
      return;
    }
    if (item.speechMode === 'openai' && item.audioB64 && item.mime) {
      await this.playAudioBlob(item.audioB64, item.mime);
    } else {
      await this.playTTS(item.speaker, item.text);
    }
  }

  private playAudioBlob(b64: string, mime: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const bytes = atob(b64);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.currentAudio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.currentAudio = null;
        resolve();
      };
      audio.onerror = (e) => {
        URL.revokeObjectURL(url);
        this.currentAudio = null;
        reject(e);
      };
      audio.play().catch(reject);
    });
  }

  private playTTS(speaker: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        reject(new Error('No speechSynthesis'));
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

      // Assign a voice when voices are ready.
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        const v = pickVoice(speaker);
        if (v) utterance.voice = v;
      } else {
        speechSynthesis.onvoiceschanged = () => {
          const v = pickVoice(speaker);
          if (v) utterance.voice = v;
        };
      }

      this.currentUtterance = utterance;
      utterance.onend = () => { this.currentUtterance = null; resolve(); };
      utterance.onerror = (e) => { this.currentUtterance = null; reject(e); };
      speechSynthesis.speak(utterance);
    });
  }
}
