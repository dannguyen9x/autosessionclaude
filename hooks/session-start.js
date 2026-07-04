#!/usr/bin/env node
'use strict';

/**
 * SessionStart hook — when a new/cleared/compacted session begins, inject any
 * pending handoff so the fresh session continues the previous work, then archive
 * the handoff so it is consumed exactly once.
 *
 * - Interactive sessions receive it via `additionalContext` (added to context
 *   before the first prompt).
 * - Headless `-p` sessions also get `initialUserMessage`, which becomes the
 *   first user turn and kicks the work off automatically.
 *
 * Defensive: any error -> exit 0 (inject nothing).
 */

const fs = require('fs');
const path = require('path');
const paths = require('../lib/paths');

const MAX_CONTEXT_CHARS = 9500; // stay under the hook 10k additionalContext cap

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const input = safeParse(readStdin()) || {};
  const cwd = input.cwd || process.cwd();
  const source = input.source || 'startup';
  if (!['startup', 'clear', 'compact'].includes(source)) return done();

  const latest = paths.latestHandoffPath(cwd);
  let content;
  try {
    content = fs.readFileSync(latest, 'utf8');
  } catch {
    return done(); // nothing pending
  }
  if (!content || !content.trim()) return done();

  // Archive (consume) first so the same handoff never injects twice.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let archivedPath = latest;
  try {
    paths.ensureDir(paths.handoffsDir(cwd));
    archivedPath = path.join(paths.handoffsDir(cwd), `consumed-${stamp}.md`);
    fs.renameSync(latest, archivedPath);
  } catch {
    // If we cannot archive, still inject but avoid a re-inject loop by best-effort delete.
    try {
      fs.unlinkSync(latest);
    } catch {
      /* ignore */
    }
  }

  let injected = content.trim();
  if (injected.length > MAX_CONTEXT_CHARS) {
    injected =
      injected.slice(0, MAX_CONTEXT_CHARS) +
      `\n\n…(handoff truncated; full text at ${archivedPath})`;
  }

  const additionalContext = [
    '# 🤝 Resumed via autosession handoff',
    '',
    'The previous session ran out of context. Below is its handoff — your only',
    "memory of that work. Read it fully and continue from its 'Next steps'.",
    '',
    injected,
  ].join('\n');

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
      initialUserMessage:
        'Continue the task described in the handoff above. Start from the "Next steps" section and keep going until the done-criteria are met.',
    },
    systemMessage: 'autosession: loaded a handoff from the previous session — continuing where it left off.',
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
