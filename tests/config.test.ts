import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/server/config.js';

describe('loadConfig', () => {
  it('selects openai speech when OPENAI_API_KEY set', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' });
    expect(cfg.speechMode).toBe('openai');
  });

  it('falls back to browser speech without OPENAI_API_KEY', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'a' });
    expect(cfg.speechMode).toBe('browser');
  });

  it('throws a clear error without ANTHROPIC_API_KEY', () => {
    expect(() => loadConfig({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('applies model defaults', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'a' });
    expect(cfg.callerModel).toBe('claude-sonnet-5-5');
    expect(cfg.receptionistModel).toBe('claude-haiku-5-5');
    expect(cfg.callerEffort).toBe('low');
  });

  it('uses TODAY override', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: 'a', TODAY: '2026-11-12' });
    expect(cfg.today).toBe('2026-11-12');
  });

  it('HOLD_SCALE parses to number, default 1', () => {
    const cfg1 = loadConfig({ ANTHROPIC_API_KEY: 'a' });
    expect(cfg1.holdScale).toBe(1);

    const cfg2 = loadConfig({ ANTHROPIC_API_KEY: 'a', HOLD_SCALE: '0.5' });
    expect(cfg2.holdScale).toBe(0.5);
  });
});
