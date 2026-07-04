'use strict';

/**
 * Minimal zero-dependency test runner. `node test/run.js` (or `npm test`).
 * Exits non-zero on failure.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readContextUsage, tokensInUse, contextWindowForModel } = require('../lib/context-usage');
const { encodeCwd } = require('../lib/paths');
const { loadConfig } = require('../lib/config');
const { containsSentinel, buildRunPrompt, parseArgs } = require('../bin/autosession');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log('      ' + (err && err.message ? err.message : String(err)));
  }
}

// --- context window detection -------------------------------------------------
test('contextWindowForModel: opus -> 200k', () => {
  assert.strictEqual(contextWindowForModel('claude-opus-4-8'), 200000);
});
test('contextWindowForModel: sonnet -> 200k', () => {
  assert.strictEqual(contextWindowForModel('claude-sonnet-5'), 200000);
});
test('contextWindowForModel: unknown -> default 200k', () => {
  assert.strictEqual(contextWindowForModel('mystery-model'), 200000);
});

// --- tokensInUse --------------------------------------------------------------
test('tokensInUse sums input + cache read + cache creation (not output)', () => {
  const u = {
    input_tokens: 2612,
    cache_creation_input_tokens: 4616,
    cache_read_input_tokens: 52421,
    output_tokens: 1436,
  };
  assert.strictEqual(tokensInUse(u), 2612 + 4616 + 52421);
});
test('tokensInUse tolerates missing fields', () => {
  assert.strictEqual(tokensInUse({ input_tokens: 10 }), 10);
  assert.strictEqual(tokensInUse(null), 0);
});

// --- cwd encoding -------------------------------------------------------------
test('encodeCwd matches observed Claude Code folder naming', () => {
  assert.strictEqual(encodeCwd('E:\\repo\\autosessionclaude'), 'E--repo-autosessionclaude');
});
test('encodeCwd replaces spaces and slashes', () => {
  assert.strictEqual(encodeCwd('/home/me/My Project'), '-home-me-My-Project');
});

// --- readContextUsage over a synthetic transcript -----------------------------
test('readContextUsage: computes percent, skips sidechain, uses last main turn', () => {
  const tmp = path.join(os.tmpdir(), `autosession-test-${process.pid}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user' } },
    {
      type: 'assistant',
      isSidechain: false,
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 500 } },
    },
    // a sub-agent turn with a huge window — must be ignored
    {
      type: 'assistant',
      isSidechain: true,
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 999999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } },
    },
    // the real latest main turn: 180k / 200k = 90%
    {
      type: 'assistant',
      isSidechain: false,
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 20000, cache_read_input_tokens: 160000, cache_creation_input_tokens: 0, output_tokens: 800 } },
    },
    'this is a truncated / malformed line and must be skipped',
  ];
  fs.writeFileSync(tmp, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  const r = readContextUsage(tmp);
  fs.unlinkSync(tmp);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.used, 180000);
  assert.strictEqual(r.window, 200000);
  assert.strictEqual(r.percent, 90);
  assert.strictEqual(r.model, 'claude-opus-4-8');
  assert.strictEqual(r.messages, 2, 'sidechain turn should not be counted');
});

test('readContextUsage: missing file -> ok:false with reason', () => {
  const r = readContextUsage(path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason);
});

// --- config -------------------------------------------------------------------
test('loadConfig: env overrides, percent threshold normalised to fraction', () => {
  const saved = process.env.AUTOSESSION_THRESHOLD;
  process.env.AUTOSESSION_THRESHOLD = '85';
  const cfg = loadConfig(os.tmpdir());
  if (saved === undefined) delete process.env.AUTOSESSION_THRESHOLD;
  else process.env.AUTOSESSION_THRESHOLD = saved;
  assert.strictEqual(cfg.threshold, 0.85);
});
test('loadConfig: defaults present', () => {
  const cfg = loadConfig(os.tmpdir());
  assert.ok(cfg.completionSentinel);
  assert.ok(cfg.claudeBin);
  assert.ok(cfg.maxSessions > 0);
});

// --- completion sentinel detection (guards against premature "done") ---------
const SENT = '<<<AUTOSESSION_TASK_COMPLETE>>>';
test('containsSentinel: matches only as the last non-empty line', () => {
  assert.strictEqual(containsSentinel(`did the work\n\n${SENT}`, SENT), true);
  assert.strictEqual(containsSentinel(`${SENT}\n`, SENT), true);
});
test('containsSentinel: does NOT match narration mid-message', () => {
  assert.strictEqual(containsSentinel(`I will print ${SENT} when done.\nStill working.`, SENT), false);
});
test('containsSentinel: does NOT match an echoed done-criteria line', () => {
  assert.strictEqual(containsSentinel(`Criteria left:\n${SENT}\nbut not yet finished`, SENT), false);
});
test('containsSentinel: empty / absent -> false', () => {
  assert.strictEqual(containsSentinel('', SENT), false);
  assert.strictEqual(containsSentinel('all done maybe', SENT), false);
});

// --- run prompt assembly ------------------------------------------------------
test('buildRunPrompt: first run embeds the task and the sentinel instruction', () => {
  const p = buildRunPrompt({ task: 'Do the thing', handoff: null, resuming: false, sentinel: SENT });
  assert.ok(p.includes('Do the thing'));
  assert.ok(p.includes(SENT));
});
test('buildRunPrompt: handoff run embeds the handoff text', () => {
  const p = buildRunPrompt({ task: 'x', handoff: '# HANDOFF\nstate', resuming: false, sentinel: SENT });
  assert.ok(p.includes('# HANDOFF'));
});

// --- arg parsing --------------------------------------------------------------
test('parseArgs: separates positionals, valued flags, and boolean flags', () => {
  const { positional, flags } = parseArgs(['run', 'a task', '--model', 'opus', '--dangerous']);
  assert.deepStrictEqual(positional, ['run', 'a task']);
  assert.strictEqual(flags.model, 'opus');
  assert.strictEqual(flags.dangerous, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
