#!/usr/bin/env node
'use strict';

/**
 * Stop hook — runs when Claude finishes a turn. Reads the transcript, computes
 * context usage, and if it has crossed the configured threshold, asks Claude
 * (once per session) to write a self-contained handoff before it stops.
 *
 * We use the documented Stop-hook control `{"decision":"block","reason":...}`,
 * which prevents the stop and continues the conversation with `reason` as
 * guidance. Because the CURRENT session still holds full context, it produces
 * the best possible handoff. A per-session flag guarantees we only do this once,
 * so there is no risk of an infinite continue loop.
 *
 * This hook is defensive: any error results in exit 0 (do nothing) so it can
 * never break a real session.
 */

const fs = require('fs');
const path = require('path');

const { readContextUsage } = require('../lib/context-usage');
const { loadConfig } = require('../lib/config');
const paths = require('../lib/paths');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const input = safeParse(readStdin());
  if (!input) return done();

  // Never re-block a hook-induced continuation.
  if (input.stop_hook_active === true) return done();

  const cwd = input.cwd || process.cwd();
  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id || 'unknown';
  if (!transcriptPath) return done();

  const cfg = loadConfig(cwd);
  const usage = readContextUsage(transcriptPath, {
    contextWindow: cfg.contextWindow || undefined,
  });
  if (!usage.ok || usage.ratio < cfg.threshold) return done();

  // Only prompt for a handoff once per session.
  const stateDir = paths.ensureDir(path.join(paths.stateDir(cwd), 'state'));
  const flag = path.join(stateDir, `${sessionId}.handoff-blocked`);
  if (fs.existsSync(flag)) return done();

  try {
    fs.writeFileSync(flag, new Date().toISOString());
  } catch {
    /* ignore */
  }

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
  const templatePath = path.join(pluginRoot, 'templates', 'handoff-template.md');
  const handoffPath = path.join(cwd, '.autosession', 'latest-handoff.md');
  const pct = usage.percent;

  const reason = [
    `⚠️ Context window is at ${pct}% (${usage.used.toLocaleString()}/${usage.window.toLocaleString()} tokens) — near full.`,
    '',
    'Before you stop, create a SESSION HANDOFF so a fresh session can continue',
    'this work with no loss of state. Do this now:',
    '',
    `1. Read the template at: ${templatePath}`,
    `2. Write a COMPLETE, self-contained handoff to: ${handoffPath}`,
    '   Fill every section with concrete detail: the original goal, exactly what',
    '   is done, the current state, the key files (real paths), decisions/gotchas,',
    '   the ordered next steps, and the done-criteria.',
    '3. Then tell the user: the handoff is ready — run `/clear` or open a new',
    '   session in this directory and autosession will auto-load it so you continue',
    '   seamlessly.',
    '',
    'After writing the file and giving that message, you may stop.',
  ].join('\n');

  const output = {
    decision: 'block',
    reason,
    systemMessage: `autosession: context at ${pct}% — writing a handoff so you can continue in a fresh session.`,
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function done() {
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0);
}
