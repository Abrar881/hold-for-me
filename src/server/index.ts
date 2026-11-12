/**
 * Hold For Me — Fastify server entry point.
 *
 * - Loads .env, validates config (exits 1 on error).
 * - Registers @fastify/websocket; one Session per socket.
 * - Serves dist/ statically when it exists.
 * - Logs speech mode and listening URL.
 */
import 'dotenv/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { loadClinics, loadProfile } from './data.js';
import { createLlm } from './llm.js';
import { createSpeech } from './speech/SpeechProvider.js';
import { Session, type SessionDeps } from './session.js';
import type { ClientMsg } from '../shared/protocol.js';

// ─── Path helpers (ESM safe) ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is two levels up from src/server/
const projectRoot = path.join(__dirname, '..', '..');
const dataDir = path.join(projectRoot, 'data');
const distDir = path.join(projectRoot, 'dist');

// ─── Config (fail fast) ───────────────────────────────────────────────────────

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

// ─── Zod schema for incoming client messages ──────────────────────────────────

const ClientMsgSchema: z.ZodType<ClientMsg> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user_utterance'),
    text: z.string().optional(),
    audioB64: z.string().optional(),
    mime: z.string().optional(),
  }),
  z.object({ type: z.literal('choose_scenario'), scenarioId: z.string() }),
  z.object({ type: z.literal('confirm'), yes: z.boolean() }),
  z.object({ type: z.literal('played'), id: z.string() }),
  z.object({ type: z.literal('listen_in'), on: z.boolean() }),
  z.object({ type: z.literal('reset') }),
]);

// ─── Build session dependencies (shared across connections) ───────────────────

const clinics = loadClinics(path.join(dataDir, 'clinics'), config.today);
const profile = loadProfile(dataDir, config.today);

const anthropic = new Anthropic({ apiKey: config.anthropicKey });

const callerLlm = createLlm(anthropic, {
  model: config.callerModel,
  effort: config.callerEffort,
  fallbacks: true,
});
const receptionistLlm = createLlm(anthropic, {
  model: config.receptionistModel,
  effort: config.receptionistEffort,
  fallbacks: false,
});
// Intake and interpret share the interpret model at low effort
const intakeLlm = createLlm(anthropic, {
  model: config.interpretModel,
  effort: 'low',
  fallbacks: false,
});
const interpretLlm = createLlm(anthropic, {
  model: config.interpretModel,
  effort: 'low',
  fallbacks: false,
});

const speech = createSpeech(config);

const sessionDeps: SessionDeps = {
  config,
  clinics,
  profile,
  dataDir,
  llms: {
    caller: callerLlm,
    receptionist: receptionistLlm,
    intake: intakeLlm,
    interpret: interpretLlm,
  },
  speech,
};

// ─── Fastify app ──────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const app = Fastify({ logger: false });

  // WebSocket plugin
  await app.register(fastifyWebsocket);

  // Static file serving (only when dist/ exists, i.e. after `npm run build`)
  if (existsSync(distDir)) {
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
    });
  }

  // WebSocket route — one Session per connection
  app.get('/ws', { websocket: true }, (socket, _req) => {
    const session = new Session(msg => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    }, sessionDeps);

    socket.on('message', (raw: Buffer | string) => {
      let parsed: ClientMsg;
      try {
        const json = JSON.parse(raw.toString()) as unknown;
        const result = ClientMsgSchema.safeParse(json);
        if (!result.success) {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
          return;
        }
        parsed = result.data;
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      session.handle(parsed).catch(err => {
        console.error('[ws] unhandled session error:', err);
      });
    });

    socket.on('close', () => {
      session.dispose();
    });

    socket.on('error', (err: Error) => {
      console.error('[ws] socket error:', err.message);
      session.dispose();
    });
  });

  // Start listening
  const address = await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`speech: ${config.speechMode}`);
  console.log(`listening on ${address}`);
}

start().catch(err => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
