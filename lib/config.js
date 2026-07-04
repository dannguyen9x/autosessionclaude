'use strict';

/**
 * config.js — resolve autosession configuration.
 *
 * Precedence (highest wins):
 *   1. Environment variables (AUTOSESSION_*)
 *   2. <cwd>/autosession.config.json
 *   3. Built-in defaults
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Fire the handoff when live context usage reaches this fraction of the
  // model window. 0.90 leaves headroom before Claude Code's own ~92-95%
  // auto-compact, so we hand off to a fresh session instead of compacting.
  threshold: 0.9,

  // Override the detected context window (tokens). null = auto-detect by model.
  contextWindow: null,

  // Executable used to spawn Claude in the autonomous runner. On Windows this
  // is often `claude.cmd`; override with AUTOSESSION_CLAUDE_BIN if not on PATH.
  claudeBin: 'claude',

  // Model for the handoff summariser and for spawned sessions. null = inherit
  // whatever `claude` defaults to.
  model: null,

  // Autonomous runner guards.
  maxSessions: 20, // hard cap on chained sessions per `autosession run`
  maxTurnsPerSession: null, // passed to `claude --max-turns` when set
  maxCostUsd: null, // stop the runner once accumulated cost reaches this (USD)

  // A run is finished when the assistant's final output line is exactly this
  // sentinel. It is delimiter-wrapped so it cannot plausibly appear except as a
  // deliberate terminal token (never in prose, and the summariser is told not to
  // reproduce it), which prevents premature "done" false-positives.
  completionSentinel: '<<<AUTOSESSION_TASK_COMPLETE>>>',

  // Permission mode for spawned sessions. 'default' prompts; the runner needs a
  // non-interactive mode to actually continue unattended. Set to
  // 'acceptEdits', 'bypassPermissions', or pass --yolo on the CLI.
  permissionMode: 'default',

  // Print a desktop/terminal-visible notice when a handoff triggers.
  notify: true,
};

// Field kinds are declared explicitly because several numeric fields default to
// null (which typeof-inference would wrongly treat as a string).
const NUMERIC = new Set(['threshold', 'contextWindow', 'maxSessions', 'maxTurnsPerSession', 'maxCostUsd']);
const BOOLEAN = new Set(['notify']);

function coerce(defaults, obj) {
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') continue;
    const val = obj[key];
    if (NUMERIC.has(key)) {
      const n = Number(val);
      if (!Number.isNaN(n)) out[key] = n;
    } else if (BOOLEAN.has(key)) {
      out[key] = val === true || val === 'true' || val === '1' || val === 1;
    } else {
      out[key] = String(val);
    }
  }
  return out;
}

function fromFile(cwd) {
  const file = path.join(cwd, 'autosession.config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function fromEnv() {
  const e = process.env;
  const pick = (name) => (e[name] !== undefined ? e[name] : undefined);
  return dropUndefined({
    threshold: pick('AUTOSESSION_THRESHOLD'),
    contextWindow: pick('AUTOSESSION_CONTEXT_WINDOW'),
    claudeBin: pick('AUTOSESSION_CLAUDE_BIN'),
    model: pick('AUTOSESSION_MODEL'),
    maxSessions: pick('AUTOSESSION_MAX_SESSIONS'),
    maxTurnsPerSession: pick('AUTOSESSION_MAX_TURNS'),
    maxCostUsd: pick('AUTOSESSION_MAX_COST'),
    completionSentinel: pick('AUTOSESSION_COMPLETION_SENTINEL'),
    permissionMode: pick('AUTOSESSION_PERMISSION_MODE'),
    notify: pick('AUTOSESSION_NOTIFY'),
  });
}

function dropUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * @param {string} cwd project directory
 * @returns {typeof DEFAULTS}
 */
function loadConfig(cwd) {
  const merged = coerce(DEFAULTS, { ...fromFile(cwd), ...fromEnv() });
  // threshold may be given as a percentage (90) instead of a fraction (0.9).
  if (merged.threshold > 1) merged.threshold = merged.threshold / 100;
  return merged;
}

module.exports = { loadConfig, DEFAULTS };
