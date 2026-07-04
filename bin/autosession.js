#!/usr/bin/env node
'use strict';

/**
 * autosession — CLI for automatic context handoff with Claude Code.
 *
 *   autosession status                 show the current context gauge
 *   autosession run "<task>"           run a task autonomously across sessions,
 *                                      handing off context whenever it fills up
 *   autosession handoff [transcript]   generate a handoff doc from a transcript
 *   autosession doctor                 check the environment / config
 *
 * See `autosession help` for flags. Zero runtime dependencies.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { readContextUsage } = require('../lib/context-usage');
const { loadConfig, DEFAULTS } = require('../lib/config');
const paths = require('../lib/paths');
const handoffLib = require('../lib/handoff');
const { runClaude, claudeVersion } = require('../lib/claude-runner');

const CWD = process.cwd();

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------- gauge output
function bar(ratio, width = 30) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function colorFor(ratio, threshold) {
  if (ratio >= threshold) return '\x1b[31m'; // red
  if (ratio >= threshold * 0.8) return '\x1b[33m'; // yellow
  return '\x1b[32m'; // green
}
const RESET = '\x1b[0m';

// ---------------------------------------------------------------- status
function cmdStatus(flags) {
  const cfg = loadConfig(CWD);
  const transcript = flags.transcript || paths.latestTranscript(CWD);
  if (!transcript) {
    console.error('No transcript found for this directory. Start a Claude Code session here first.');
    process.exit(1);
  }
  const u = readContextUsage(transcript, {
    contextWindow: cfg.contextWindow || undefined,
  });
  if (!u.ok) {
    console.log(`transcript: ${transcript}`);
    console.log(`context: (not enough data yet — ${u.reason})`);
    return;
  }
  const c = colorFor(u.ratio, cfg.threshold);
  console.log('');
  console.log(`  autosession — context usage`);
  console.log(`  ${c}${bar(u.ratio)}${RESET} ${c}${u.percent}%${RESET} of ${u.window.toLocaleString()} tokens`);
  console.log(`  used: ${u.used.toLocaleString()} tokens   model: ${u.model || 'unknown'}   turns: ${u.messages}`);
  console.log(`  threshold: ${Math.round(cfg.threshold * 100)}%  ->  ${u.ratio >= cfg.threshold ? c + 'HANDOFF RECOMMENDED' + RESET : 'ok'}`);
  console.log(`  transcript: ${transcript}`);
  console.log('');
}

// ---------------------------------------------------------------- handoff (gen)
async function cmdHandoff(positional, flags) {
  const cfg = loadConfig(CWD);
  const transcript = positional[0] || flags.transcript || paths.latestTranscript(CWD);
  if (!transcript || !fs.existsSync(transcript)) {
    console.error('Provide a transcript path, or run inside a directory with a Claude session.');
    process.exit(1);
  }
  console.error(`Summarising ${transcript} ...`);
  const text = handoffLib.readTranscriptText(transcript);
  if (!text) {
    console.error('Could not read the transcript.');
    process.exit(1);
  }
  const prompt = handoffLib.buildSummaryPrompt({ transcript: text });
  const res = await runClaude({
    promptText: prompt,
    cwd: CWD,
    claudeBin: cfg.claudeBin,
    model: cfg.model,
    permissionMode: 'default',
    maxTurns: 3,
  });
  if (!res.ok || !res.resultText.trim()) {
    console.error(`Handoff generation failed (exit ${res.exitCode}). ${res.stderr}`);
    process.exit(1);
  }
  const saved = handoffLib.saveHandoff(CWD, res.resultText.trim(), stamp());
  console.error(`Handoff written:\n  ${saved.file}\n  ${saved.latest} (latest pointer)`);
  if (flags.print) console.log(res.resultText.trim());
}

// ---------------------------------------------------------------- run (loop)
function doneInstruction(sentinel) {
  return [
    '',
    '--- autosession control ---',
    'Work autonomously. Do NOT ask the user questions; make reasonable decisions and proceed.',
    'When — and ONLY when — the ENTIRE task is fully complete and verified, make the',
    'VERY LAST line of your final message be exactly the following token and nothing',
    'else (no surrounding text, no code fence, nothing after it):',
    sentinel,
    'Do not write that token anywhere else, ever. If the task is not finished, keep',
    'working and do NOT emit it.',
  ].join('\n');
}

function buildRunPrompt({ task, handoff, resuming, sentinel }) {
  if (handoff) {
    return [
      'You are a FRESH Claude Code session continuing work that a previous session',
      'started but could not finish because its context window filled up. The',
      'handoff below is your only memory of that work. Read it fully, then continue',
      "from its 'Next steps'.",
      '',
      handoff,
      doneInstruction(sentinel),
    ].join('\n');
  }
  if (resuming) {
    return ['Continue working on the task. Pick up exactly where you left off.', doneInstruction(sentinel)].join('\n');
  }
  return [task, doneInstruction(sentinel)].join('\n');
}

const AUTONOMY_MODES = new Set(['acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']);

async function cmdRun(positional, flags) {
  const cfg = loadConfig(CWD);
  const task = positional.join(' ').trim() || (typeof flags.task === 'string' ? flags.task : '');
  if (!task) {
    console.error('Usage: autosession run "<task description>"');
    process.exit(1);
  }

  // Resolve overrides from flags.
  const threshold = flags.threshold ? normThreshold(Number(flags.threshold)) : cfg.threshold;
  const maxSessions = flags['max-sessions'] ? Number(flags['max-sessions']) : cfg.maxSessions;
  const maxTurns = flags['max-turns'] ? Number(flags['max-turns']) : cfg.maxTurnsPerSession;
  const maxCostUsd = flags['max-cost'] ? Number(flags['max-cost']) : cfg.maxCostUsd || null;
  const model = typeof flags.model === 'string' ? flags.model : cfg.model;
  let permissionMode = typeof flags['permission-mode'] === 'string' ? flags['permission-mode'] : cfg.permissionMode;
  if (flags.dangerous || flags.yolo) permissionMode = 'bypassPermissions';
  const sentinel = cfg.completionSentinel;

  // Preflight: is claude reachable?
  const ver = await claudeVersion(cfg.claudeBin);
  banner();
  console.log(`  task        : ${truncate(task, 68)}`);
  console.log(`  claude      : ${ver || `NOT FOUND ("${cfg.claudeBin}")`}`);
  console.log(`  model       : ${model || '(default)'}`);
  console.log(`  permission  : ${permissionMode}${AUTONOMY_MODES.has(permissionMode) ? '' : '  <- may stall on prompts; use --dangerous for full autonomy'}`);
  console.log(`  threshold   : ${Math.round(threshold * 100)}%   maxSessions: ${maxSessions}   maxTurns/sess: ${maxTurns || '∞'}   maxCost: ${maxCostUsd ? '$' + maxCostUsd : '∞'}`);
  console.log('  ' + '-'.repeat(58));
  if (!ver) {
    console.error(`\n  Cannot find the "${cfg.claudeBin}" CLI. Install Claude Code or set AUTOSESSION_CLAUDE_BIN.`);
    process.exit(1);
  }
  if (!AUTONOMY_MODES.has(permissionMode)) {
    console.log(`\n  ⚠ permission-mode "${permissionMode}" will likely prevent file edits in headless mode.`);
    console.log('     Re-run with --dangerous (bypassPermissions) for unattended coding. Continuing anyway...\n');
  }

  let handoff = null;
  let resumeId = null;
  let totalCost = 0;
  let consecutiveHandoffs = 0;

  for (let session = 1; session <= maxSessions; session++) {
    const resuming = !handoff && !!resumeId;
    const prompt = buildRunPrompt({ task, handoff, resuming, sentinel });
    const modeLabel = handoff ? 'HANDOFF→fresh' : resuming ? `resume ${short(resumeId)}` : 'start';
    console.log(`\n▶ session ${session}/${maxSessions} (${modeLabel})`);

    const res = await runClaude({
      promptText: prompt,
      cwd: CWD,
      claudeBin: cfg.claudeBin,
      model,
      permissionMode,
      resume: resuming ? resumeId : null,
      maxTurns,
      onStderr: (s) => process.stderr.write(dim(s)),
    });

    totalCost += res.costUsd || 0;
    const sid = res.sessionId;
    console.log(`  ↳ exit ${res.exitCode}  session ${short(sid)}  cost $${(res.costUsd || 0).toFixed(4)}  total $${totalCost.toFixed(4)}`);

    if (!res.ok && !res.resultText) {
      console.error(`  ✖ session failed: ${firstLine(res.stderr)}`);
      break;
    }

    // Completion?
    if (containsSentinel(res.resultText, sentinel)) {
      console.log(`\n✅ Task reported complete after ${session} session(s). Total cost $${totalCost.toFixed(4)}.`);
      return;
    }

    // Cost cap?
    if (maxCostUsd != null && totalCost >= maxCostUsd) {
      console.log(`\n⛔ Cost cap $${maxCostUsd} reached (spent $${totalCost.toFixed(4)}). Stopping.`);
      return;
    }

    // Context check — resolve the transcript STRICTLY by this session's id. Never
    // fall back to "newest .jsonl": the handoff summariser writes its own
    // transcript in the same dir and could otherwise be picked as newest.
    const transcript = sid ? transcriptFor(sid) : null;
    const usage = transcript
      ? readContextUsage(transcript, { contextWindow: cfg.contextWindow || undefined })
      : { ok: false };
    if (usage.ok) {
      console.log(`  ↳ context ${usage.percent}% (${usage.used.toLocaleString()}/${usage.window.toLocaleString()})`);
    } else if (!transcript) {
      console.log('  ↳ context unknown (could not resolve this session\'s transcript)');
    }

    if (usage.ok && usage.ratio >= threshold) {
      if (++consecutiveHandoffs > 3) {
        console.log('\n⛔ Handed off 3 times in a row without the context dropping — stopping to avoid churn.');
        console.log('  Inspect .autosession/handoffs/ and re-run, perhaps with a larger --max-turns.');
        return;
      }
      console.log(`  ↳ context ≥ ${Math.round(threshold * 100)}% → generating handoff and starting a fresh session`);
      const text = handoffLib.readTranscriptText(transcript);
      if (!text) {
        console.error('  ✖ could not read transcript to summarise; resuming the same session instead.');
        handoff = null;
        resumeId = sid;
        continue;
      }
      const sres = await runClaude({
        promptText: handoffLib.buildSummaryPrompt({ transcript: text }),
        cwd: CWD,
        claudeBin: cfg.claudeBin,
        model,
        permissionMode: 'default',
        maxTurns: 3,
      });
      totalCost += sres.costUsd || 0;
      if (!sres.ok || !sres.resultText.trim()) {
        console.error('  ✖ handoff generation failed; stopping to avoid losing context.');
        break;
      }
      handoff = sres.resultText.trim();
      // updateLatest:false — the runner injects this handoff itself via the next
      // prompt, so we must NOT leave a latest-handoff.md for the plugin's
      // SessionStart hook to inject a second time.
      const saved = handoffLib.saveHandoff(CWD, handoff, stamp(), { updateLatest: false });
      console.log(`  ↳ handoff saved: ${saved.file}`);
      resumeId = null; // next iteration starts fresh with the handoff

      // Re-check the cost cap: the summariser above spent tokens too.
      if (maxCostUsd != null && totalCost >= maxCostUsd) {
        console.log(`\n⛔ Cost cap $${maxCostUsd} reached after handoff (spent $${totalCost.toFixed(4)}). Stopping.`);
        console.log('  The handoff was saved; re-run to continue.');
        return;
      }
    } else {
      // Not done, context still has room → continue the same session.
      consecutiveHandoffs = 0;
      handoff = null;
      resumeId = sid;
      if (!resumeId) {
        console.error('  ✖ no session id to resume and task not complete; stopping.');
        break;
      }
    }
  }

  console.log(`\n⏹ Reached the ${maxSessions}-session limit without a completion signal. Total cost $${totalCost.toFixed(4)}.`);
  console.log('  Inspect .autosession/handoffs/ for the latest state, then re-run to continue.');
}

// ---------------------------------------------------------------- doctor
async function cmdDoctor() {
  const cfg = loadConfig(CWD);
  banner();
  console.log(`  node        : ${process.version}`);
  const ver = await claudeVersion(cfg.claudeBin);
  console.log(`  claude      : ${ver || `NOT FOUND ("${cfg.claudeBin}") — set AUTOSESSION_CLAUDE_BIN`}`);
  console.log(`  cwd         : ${CWD}`);
  const t = paths.latestTranscript(CWD);
  console.log(`  transcript  : ${t || '(none yet for this directory)'}`);
  if (t) {
    const u = readContextUsage(t, { contextWindow: cfg.contextWindow || undefined });
    if (u.ok) console.log(`  context     : ${u.percent}% of ${u.window.toLocaleString()} (${u.model})`);
  }
  console.log('  ' + '-'.repeat(58));
  console.log('  config:');
  for (const k of Object.keys(DEFAULTS)) {
    console.log(`    ${k.padEnd(20)} ${JSON.stringify(cfg[k])}`);
  }
  console.log('');
}

// ---------------------------------------------------------------- helpers
function normThreshold(n) {
  if (Number.isNaN(n)) return DEFAULTS.threshold;
  return n > 1 ? n / 100 : n;
}
function transcriptFor(sessionId) {
  const p = path.join(paths.projectDir(CWD), `${sessionId}.jsonl`);
  return fs.existsSync(p) ? p : null;
}
function containsSentinel(text, sentinel) {
  if (!text) return false;
  // Only accept the sentinel as the LAST non-empty line of the model's output.
  // This, plus the delimiter-wrapped token, prevents false positives from the
  // model narrating ("I will print ...") or echoing done-criteria mid-message.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines[lines.length - 1] === sentinel;
}
function short(id) {
  return id ? id.slice(0, 8) : '????????';
}
function firstLine(s) {
  return (s || '').split(/\r?\n/).find(Boolean) || '(no output)';
}
function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function dim(s) {
  return `\x1b[2m${s}\x1b[0m`;
}
function banner() {
  console.log('\n  ⇢ autosession  ·  automatic context handoff for Claude Code');
}

function help() {
  console.log(`
autosession — automatic context handoff for Claude Code

USAGE
  autosession status                     Show the context-usage gauge for this directory
  autosession run "<task>"               Run a task autonomously, handing off across sessions
  autosession handoff [transcript]       Generate a handoff document from a transcript
  autosession doctor                     Print environment + resolved config
  autosession help                       This help

RUN FLAGS
  --dangerous, --yolo                    Use bypassPermissions (needed for unattended editing)
  --permission-mode <mode>               default|acceptEdits|plan|auto|dontAsk|bypassPermissions
  --model <alias|id>                     opus | sonnet | haiku | fable | full id
  --threshold <pct|frac>                 Handoff threshold (e.g. 90 or 0.9)
  --max-sessions <n>                     Max chained sessions (guard against runaway loops)
  --max-turns <n>                        --max-turns passed to each claude session
  --max-cost <usd>                       Stop once accumulated cost reaches this

CONFIG
  Reads <cwd>/autosession.config.json and AUTOSESSION_* env vars.
  Keys: ${Object.keys(DEFAULTS).join(', ')}

EXAMPLES
  autosession status
  autosession run "Refactor the auth module and add tests" --dangerous --model opus
  AUTOSESSION_CLAUDE_BIN=claude.cmd autosession run "Build the landing page" --max-cost 5
`);
}

// ---------------------------------------------------------------- entrypoint
async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'status':
      return cmdStatus(flags);
    case 'run':
      return cmdRun(positional, flags);
    case 'handoff':
      return cmdHandoff(positional, flags);
    case 'doctor':
      return cmdDoctor();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      console.error(`Unknown command: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}

// Exported for unit testing (see test/run.js).
module.exports = { containsSentinel, buildRunPrompt, doneInstruction, parseArgs };
