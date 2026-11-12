/**
 * CLI scenario runner for Hold For Me.
 *
 * Usage: npm run scenario -- <clinicId> [--runs N] [--answer "yes"|"no"|"silent"] [--fast]
 *
 * Runs the full call pipeline in text mode (no speech synthesis/transcription)
 * so that scenarios can be validated without a browser.
 *
 * --fast      sets holdScale 0 (instant hold transitions)
 * --runs N    repeat the scenario N times and print "passed X/N"
 * --answer    response for askUser prompts; default is per-clinic (R4)
 *             "silent" simulates a timeout (returns null)
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../server/config.js';
import { createLlm, type LlmCall } from '../server/llm.js';
import { loadClinics, loadProfile, loadCalendar } from '../server/data.js';
import { Intake } from '../server/agents/intake.js';
import { SimulatedLine } from '../server/line/SimulatedLine.js';
import { runCall, type CallIO, type CallDeps } from '../server/orchestrator.js';
import { BrowserSpeech } from '../server/speech/SpeechProvider.js';
import type { CallOutcome, Speaker } from '../shared/types.js';
import type { ServerMsg } from '../shared/protocol.js';
import type { CallState } from '../server/agents/callerTools.js';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const SPEAKER_COLOR: Record<string, string> = {
  agent: C.cyan,
  receptionist: C.yellow,
  ivr: C.dim,
  assistant: C.blue,
  user: C.magenta,
};

function colorFor(speaker: string): string {
  return SPEAKER_COLOR[speaker] ?? C.reset;
}

function colorLine(speaker: string, label: string, text: string): string {
  const col = colorFor(speaker);
  return `${col}${C.bold}[${label}]${C.reset}${col} ${text}${C.reset}`;
}

// ─── Per-clinic default answers (R4) ─────────────────────────────────────────

const CLINIC_DEFAULT_ANSWER: Record<string, string> = {
  riverside: 'yes, and my insurance number is AB123456',
};

/** Return the default answer for a clinic (R4): riverside → insurance string; others → "yes". */
export function defaultAnswer(clinicId: string): string {
  return CLINIC_DEFAULT_ANSWER[clinicId] ?? 'yes';
}

// ─── Expected outcomes per scenario ───────────────────────────────────────────

interface ExpectedOutcome {
  status: 'booked' | 'not_booked';
  /** Partial time string that must appear in booking.start, e.g. "10:30" */
  time?: string;
  /** If true, the scenario must NOT trigger a needs_user event. */
  noNeedsUser?: boolean;
  /** If true, the scenario MUST trigger at least one needs_user event. */
  requiresNeedsUser?: boolean;
}

const EXPECTED: Record<string, ExpectedOutcome> = {
  'bright-smile': { status: 'booked', time: '10:30', noNeedsUser: true },
  'clearview': { status: 'booked', time: '15:00' },
  'riverside': { status: 'booked', requiresNeedsUser: true },
  'sunny-eyes': { status: 'not_booked' },
};

// ─── runScenario ──────────────────────────────────────────────────────────────

export interface RunScenarioOpts {
  clinicId: string;
  /** User answer for askUser prompts; "silent" returns null. Defaults to per-clinic (R4). */
  answer?: string;
  /** When true, holdScale is 0 (instant hold). */
  fast: boolean;
  llms: {
    caller: LlmCall;
    receptionist: LlmCall;
    intake: LlmCall;
    interpret: LlmCall;
  };
  /** Path to the data directory (contains profile.json, clinics/, calendar.json). */
  dataDir: string;
  /** Today's date as YYYY-MM-DD. */
  today: string;
  /** Receives colored transcript/status lines. Defaults to console.log. */
  log?: (line: string) => void;
}

export interface ScenarioResult {
  outcome: CallOutcome;
  /** True if at least one needs_user event was emitted during the call. */
  needsUserFired: boolean;
}

export async function runScenario(opts: RunScenarioOpts): Promise<ScenarioResult> {
  const { clinicId, fast, llms, dataDir, today } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const answer = opts.answer ?? defaultAnswer(clinicId);

  // ── Load data ──────────────────────────────────────────────────────────────
  const clinics = loadClinics(`${dataDir}/clinics`, today);
  const profile = loadProfile(dataDir, today);
  const calendar = loadCalendar(dataDir, today);

  const clinic = clinics.find(c => c.id === clinicId);
  if (!clinic) {
    throw new Error(`Clinic not found: ${clinicId}. Known clinics: ${clinics.map(c => c.id).join(', ')}`);
  }

  // ── Intake ─────────────────────────────────────────────────────────────────
  log(`${C.dim}[intake] Processing demo request: ${clinic.demoRequest}${C.reset}`);
  const intake = new Intake(clinics, profile, today, llms.intake);

  let question = clinic.demoRequest;
  let request = null;
  for (let attempts = 0; attempts < 5; attempts++) {
    const result = await intake.hear(question);
    if (result.kind === 'ready') {
      log(`${C.dim}[intake] ${result.summary}${C.reset}`);
      request = result.request;
      break;
    }
    // Clarifying question — re-submit the demo request as the answer
    log(`${C.dim}[intake] Q: ${result.question}${C.reset}`);
    question = clinic.demoRequest;
  }
  if (!request) {
    throw new Error(`Intake did not reach ready state after 5 attempts for clinic: ${clinicId}`);
  }

  // ── Build CallIO ───────────────────────────────────────────────────────────
  let needsUserFired = false;
  const io: CallIO = {
    emit(msg: ServerMsg): void {
      switch (msg.type) {
        case 'utterance':
          log(colorLine(msg.speaker, msg.speaker, msg.text));
          break;
        case 'call_status':
          log(`${C.dim}[status] ${msg.phase}${C.reset}`);
          break;
        case 'hold':
          log(`${C.dim}[hold] ${msg.state}${msg.state === 'start' && msg.seconds !== undefined ? ` (${msg.seconds}s)` : ''}${C.reset}`);
          break;
        case 'needs_user':
          needsUserFired = true;
          log(colorLine('user', 'needs_user', msg.question));
          break;
        case 'call_ended':
          log(`${C.bold}[outcome] ${msg.outcome.status}${C.reset}`);
          break;
        case 'offer':
          // Gate result logged at debug level
          log(`${C.dim}[offer] ${msg.offer.offerId} gate=${msg.gate.ok ? 'pass' : 'fail'}${C.reset}`);
          break;
        default:
          break;
      }
    },

    // speak is for audio playback — no-op in CLI text mode
    async speak(_u, _audio): Promise<void> {
      // text already emitted via emit(type:'utterance')
    },

    async askUser(question: string, _timeoutMs: number, _attempt: number): Promise<string | null> {
      log(colorLine('user', 'askUser', question));
      if (answer === 'silent') {
        log(`${C.dim}[askUser] silent (no answer)${C.reset}`);
        return null;
      }
      log(colorLine('user', 'answer', answer));
      return answer;
    },
  };

  // ── Build state and deps ───────────────────────────────────────────────────
  const state: CallState = {
    request,
    profile,
    calendar,
    approvals: [],
    offers: new Map(),
    userAnswers: [],
  };

  const line = new SimulatedLine(clinic, profile, llms.receptionist, {
    holdScale: fast ? 0 : 1,
    today,
  });

  const deps: CallDeps = {
    line,
    llm: llms.caller,
    interpretLlm: llms.interpret,
    speech: new BrowserSpeech(),
    io,
    clinic,
    today,
  };

  const ac = new AbortController();
  const outcome = await runCall(state, deps, ac.signal);
  return { outcome, needsUserFired };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0].startsWith('--')) {
    console.error(
      'Usage: npm run scenario -- <clinicId> [--runs N] [--answer "yes"|"no"|"silent"] [--fast]',
    );
    process.exit(1);
  }

  const clinicId = args[0];
  let runs = 1;
  let answer: string | undefined;
  let fast = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--runs' && i + 1 < args.length) {
      runs = parseInt(args[++i], 10);
      if (isNaN(runs) || runs < 1) {
        console.error('--runs must be a positive integer');
        process.exit(1);
      }
    } else if (args[i] === '--answer' && i + 1 < args.length) {
      answer = args[++i];
    } else if (args[i] === '--fast') {
      fast = true;
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
    }
  }

  // ── Load config ────────────────────────────────────────────────────────────
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // ── Build LLM clients ──────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey: config.anthropicKey });

  const llms = {
    caller: createLlm(client, {
      model: config.callerModel,
      effort: config.callerEffort,
      fallbacks: true,
    }),
    receptionist: createLlm(client, {
      model: config.receptionistModel,
      effort: config.receptionistEffort,
      fallbacks: false,
    }),
    intake: createLlm(client, {
      model: config.interpretModel,
      effort: 'low',
      fallbacks: false,
    }),
    interpret: createLlm(client, {
      model: config.interpretModel,
      effort: 'low',
      fallbacks: false,
    }),
  };

  // ── Run scenarios ──────────────────────────────────────────────────────────
  const expected = EXPECTED[clinicId];
  let passed = 0;

  for (let i = 0; i < runs; i++) {
    console.log(`\n${C.bold}=== Run ${i + 1}/${runs} ===${C.reset}`);
    try {
      const { outcome, needsUserFired } = await runScenario({
        clinicId,
        answer,
        fast,
        llms,
        dataDir: 'data',
        today: config.today,
      });

      const statusColor = outcome.status === 'booked' ? C.green : C.red;
      console.log(`${statusColor}${C.bold}${outcome.status}${C.reset} - ${outcome.summary}`);
      if (outcome.booking) {
        console.log(`${C.dim}  booking: ${outcome.booking.start} at ${outcome.booking.clinicName}${C.reset}`);
      }

      let runPassed = true;
      if (expected) {
        const failures: string[] = [];
        if (outcome.status !== expected.status) {
          failures.push(`expected status "${expected.status}", got "${outcome.status}"`);
        }
        if (expected.time && outcome.booking && !outcome.booking.start.includes(expected.time)) {
          failures.push(`expected booking time "${expected.time}", got "${outcome.booking.start}"`);
        }
        if (expected.noNeedsUser && needsUserFired) {
          failures.push(`expected NO needs_user but one fired`);
        }
        if (expected.requiresNeedsUser && !needsUserFired) {
          failures.push(`expected at least one needs_user but none fired`);
        }
        if (failures.length > 0) {
          runPassed = false;
          for (const f of failures) {
            console.log(`${C.red}✗ FAIL: ${f}${C.reset}`);
          }
        } else {
          console.log(`${C.green}✓ PASS${C.reset}`);
        }
      } else {
        console.log(`${C.yellow}? no expected outcome defined — treating as pass${C.reset}`);
      }

      if (runPassed) passed++;
    } catch (err) {
      console.error(
        `${C.red}Run ${i + 1} error: ${err instanceof Error ? err.message : String(err)}${C.reset}`,
      );
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const allPassed = passed === runs;
  const summaryColor = allPassed ? C.green : C.red;
  console.log(`\n${summaryColor}${C.bold}passed ${passed}/${runs}${C.reset}`);

  if (!allPassed) process.exit(1);
}

// Only run main() when this file is the CLI entry-point, not when imported by tests.
// ESM equivalent of `if (require.main === module)`.
const _isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (_isMain) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
