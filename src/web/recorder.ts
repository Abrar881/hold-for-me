/**
 * recorder.ts — MediaRecorder-based audio capture for OpenAI voice mode.
 *
 * Exports:
 *  - vadShouldStop: pure function usable in Node tests (no DOM deps)
 *  - Recorder: MediaRecorder wrapper; browser-only
 */

export interface VadSample {
  /** Timestamp in ms (monotonic, e.g. from Date.now() or performance.now()) */
  t: number;
  /** Root-mean-square amplitude, range 0–1 */
  rms: number;
}

export interface VadOpts {
  /** RMS threshold above which a sample is counted as speech. Default 0.02. */
  speechRms?: number;
  /** Duration of silence (ms) after speech that triggers a stop. Default 1200. */
  silenceMs?: number;
}

/**
 * Pure VAD decision function — no side-effects, safe to run in Node.
 *
 * Returns true iff:
 *  1. At least one sample exceeded speechRms (speech has occurred), AND
 *  2. The most-recent run of sub-threshold samples spans ≥ silenceMs.
 */
export function vadShouldStop(
  samples: VadSample[],
  opts: VadOpts = {},
): boolean {
  const speechRms = opts.speechRms ?? 0.02;
  const silenceMs = opts.silenceMs ?? 1200;

  // Find the index of the last sample at or above the speech threshold.
  let lastSpeechIdx = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].rms >= speechRms) {
      lastSpeechIdx = i;
    }
  }

  // No speech detected at all.
  if (lastSpeechIdx === -1) return false;

  // Speech was the most-recent sample — still speaking.
  if (lastSpeechIdx === samples.length - 1) return false;

  // Check how long the silence after the last speech sample has lasted.
  const speechEnd = samples[lastSpeechIdx].t;
  const latest = samples[samples.length - 1].t;
  return latest - speechEnd >= silenceMs;
}

// ─── Browser-only ────────────────────────────────────────────────────────────

export interface RecorderOpts {
  /**
   * When true, the Recorder polls an AnalyserNode with vadShouldStop and
   * resolves early when silence is detected.
   */
  autoStop: boolean;
  /** Hard timeout in ms. The recording always stops by this limit. */
  maxMs: number;
}

/**
 * MediaRecorder-based audio recorder.
 *
 * Usage:
 *   const rec = new Recorder();
 *   const blob = await rec.start({ autoStop: false, maxMs: 60000 });
 *   // stop manually:
 *   rec.stop();
 */
export class Recorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stopFn: (() => void) | null = null;

  /**
   * Start recording from the default microphone.
   * Resolves with a Blob when recording ends.
   * With autoStop:true the recording ends on silence (via VAD).
   * Calling stop() ends it early regardless of autoStop.
   */
  async start(opts: RecorderOpts): Promise<Blob> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Prefer opus for best quality/size on WebRTC-capable browsers.
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    const mr = new MediaRecorder(stream, { mimeType });
    this.mediaRecorder = mr;
    const chunks: BlobPart[] = [];

    return new Promise<Blob>((resolve, reject) => {
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        this.mediaRecorder = null;
        resolve(new Blob(chunks, { type: mimeType }));
      };

      mr.onerror = (e) => {
        stream.getTracks().forEach(t => t.stop());
        this.mediaRecorder = null;
        reject((e as any).error ?? new Error('MediaRecorder error'));
      };

      mr.start(100); // collect data every 100 ms

      let vadInterval: ReturnType<typeof setInterval> | null = null;
      let audioCtx: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      let hardTimer: ReturnType<typeof setTimeout>;

      const doStop = () => {
        clearTimeout(hardTimer);
        if (vadInterval !== null) {
          clearInterval(vadInterval);
          vadInterval = null;
        }
        if (audioCtx) {
          audioCtx.close().catch(() => undefined);
          audioCtx = null;
          analyser = null;
        }
        if (mr.state !== 'inactive') {
          mr.stop();
        }
      };

      if (opts.autoStop) {
        audioCtx = new AudioContext();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const src = audioCtx.createMediaStreamSource(stream);
        src.connect(analyser);

        const buf = new Float32Array(analyser.fftSize);
        const samples: VadSample[] = [];
        const startTime = Date.now();

        vadInterval = setInterval(() => {
          if (!analyser) return;
          analyser.getFloatTimeDomainData(buf);
          // Compute RMS
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          samples.push({ t: Date.now() - startTime, rms });

          if (vadShouldStop(samples)) {
            doStop();
          }
        }, 50);
      }

      // Hard timeout
      hardTimer = setTimeout(doStop, opts.maxMs);

      this.stopFn = doStop;
    });
  }

  /** Stop recording early. No-op if not recording. */
  stop(): void {
    if (this.stopFn) {
      this.stopFn();
      this.stopFn = null;
    }
  }
}
