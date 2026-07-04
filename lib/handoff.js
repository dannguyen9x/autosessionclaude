'use strict';

/**
 * handoff.js — build the summariser prompt and read/write handoff documents.
 *
 * The heavy lifting (actually summarising the old session) is done by Claude
 * itself: we feed it the old transcript and the template below and ask for a
 * filled-in handoff. This module just constructs that prompt and manages the
 * files on disk. Spawning Claude lives in bin/autosession.js and the hooks.
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'handoff-template.md');

function loadTemplate() {
  try {
    return fs.readFileSync(TEMPLATE_PATH, 'utf8');
  } catch {
    return '# Session Handoff\n\n(template missing — summarise the session below)\n';
  }
}

/**
 * Build the prompt handed to `claude -p` to generate a handoff. It is given the
 * raw transcript as context and asked to fill in the template.
 *
 * @param {object} args
 * @param {string} args.transcript raw .jsonl (or already-extracted text)
 * @returns {string}
 */
function buildSummaryPrompt({ transcript }) {
  const template = loadTemplate();
  return [
    'You are writing a SESSION HANDOFF so a brand-new Claude Code session can',
    'seamlessly continue this work with no other memory. The session below ran',
    "out of context. Read its transcript and fill in EVERY section of the",
    'template with concrete, specific detail (real file paths, real commands,',
    'real decisions). Do not invent progress that did not happen. Omit the HTML',
    'comment hints in your output. Keep it tight but complete.',
    '',
    'Describe the done-criteria (section 7) in plain prose. Do NOT include any',
    'special completion token or sentinel — the runner supplies that separately.',
    '',
    '=== TEMPLATE TO FILL IN ===',
    template,
    '',
    '=== TRANSCRIPT OF THE SESSION TO SUMMARISE (JSON-Lines) ===',
    transcript,
    '',
    '=== END TRANSCRIPT ===',
    '',
    'Output ONLY the finished handoff markdown, nothing else.',
  ].join('\n');
}

/**
 * Persist a handoff document. Writes a timestamped copy under
 * <cwd>/.autosession/handoffs/ and updates the latest-handoff.md pointer.
 *
 * @param {string} cwd
 * @param {string} content finished handoff markdown
 * @param {string} stamp filesystem-safe timestamp (caller supplies; scripts
 *                        cannot call Date.now in some sandboxes)
 * @param {object} [opts]
 * @param {boolean} [opts.updateLatest=true] also write the latest-handoff.md
 *        pointer that the SessionStart hook consumes. The autonomous runner
 *        passes false: it injects the handoff itself via stdin, so leaving the
 *        pointer would make the plugin's SessionStart hook double-inject it.
 * @returns {{ file: string, latest: string|null }}
 */
function saveHandoff(cwd, content, stamp, opts = {}) {
  const updateLatest = opts.updateLatest !== false;
  paths.ensureDir(paths.handoffsDir(cwd));
  const file = path.join(paths.handoffsDir(cwd), `handoff-${stamp}.md`);
  fs.writeFileSync(file, content, 'utf8');
  let latest = null;
  if (updateLatest) {
    latest = paths.latestHandoffPath(cwd);
    fs.writeFileSync(latest, content, 'utf8');
  }
  return { file, latest };
}

/** Read the most recent handoff, or null if none. */
function readLatestHandoff(cwd) {
  try {
    return fs.readFileSync(paths.latestHandoffPath(cwd), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read raw transcript text, trimming to the last `maxChars` if huge. Never
 * throws — returns '' if the file is missing/unreadable, so callers can decide
 * to skip a handoff rather than crash the run.
 */
function readTranscriptText(transcriptPath, maxChars = 600000) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  if (raw.length > maxChars) raw = raw.slice(raw.length - maxChars);
  return raw;
}

module.exports = {
  loadTemplate,
  buildSummaryPrompt,
  saveHandoff,
  readLatestHandoff,
  readTranscriptText,
  TEMPLATE_PATH,
};
