'use strict';

/**
 * paths.js — locate Claude Code transcripts and autosession's own storage.
 *
 * Claude Code stores each session transcript at:
 *   <home>/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * where <encoded-cwd> is the absolute working directory with every character
 * that is not [A-Za-z0-9] replaced by '-'. Example (observed on Windows):
 *   E:\repo\autosessionclaude  ->  E--repo-autosessionclaude
 *
 * Hooks receive `transcript_path` directly, so encoding is only needed by the
 * CLI (`autosession status`) when invoked outside a hook.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Encode an absolute cwd the way Claude Code names its project folders. */
function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Root of Claude Code's config/data dir, honouring CLAUDE_CONFIG_DIR. */
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Directory that holds a project's transcripts. */
function projectDir(cwd) {
  return path.join(claudeHome(), 'projects', encodeCwd(cwd));
}

/**
 * Newest transcript (.jsonl) for a project, or null. Sub-agent transcripts live
 * in nested folders; the main session transcript is a flat <id>.jsonl file, so
 * we only look one level deep.
 */
function latestTranscript(cwd) {
  const dir = projectDir(cwd);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      best = full;
    }
  }
  return best;
}

/** autosession's per-project storage (handoffs, flags, state). */
function stateDir(cwd) {
  return path.join(cwd, '.autosession');
}

function handoffsDir(cwd) {
  return path.join(stateDir(cwd), 'handoffs');
}

/** Pointer file that always names the most recent handoff. */
function latestHandoffPath(cwd) {
  return path.join(stateDir(cwd), 'latest-handoff.md');
}

/** Flag written by the Stop hook to signal "context is over threshold". */
function handoffFlagPath(cwd) {
  return path.join(stateDir(cwd), 'handoff-needed.json');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  encodeCwd,
  claudeHome,
  projectDir,
  latestTranscript,
  stateDir,
  handoffsDir,
  latestHandoffPath,
  handoffFlagPath,
  ensureDir,
};
