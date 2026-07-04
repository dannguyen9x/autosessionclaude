'use strict';

/**
 * context-usage.js — read a Claude Code transcript (.jsonl) and compute how
 * much of the model's context window is currently in use.
 *
 * A Claude Code transcript is JSON-Lines: one JSON object per line. Assistant
 * turns look like: { type: "assistant", isSidechain: false, message: { model,
 * usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 * output_tokens } } }.
 *
 * The number of tokens the model actually saw on its most recent turn (i.e. the
 * live context size) is:
 *
 *     input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * output_tokens is what it generated this turn and is NOT part of the prompt it
 * saw, so it is excluded from "used". Sub-agent turns are written to the same
 * file with isSidechain === true; those do not consume the MAIN thread's window,
 * so we skip them.
 *
 * This module has zero dependencies and never throws on a malformed line — it
 * just skips it — so it is safe to call from a hook on a partially-written file.
 */

const fs = require('fs');

/** Known context-window sizes (tokens) keyed by a substring of the model id. */
const MODEL_WINDOWS = [
  { match: /\[1m\]|-1m\b/i, tokens: 1000000 }, // explicit 1M context variants
  { match: /opus/i, tokens: 200000 },
  { match: /sonnet/i, tokens: 200000 },
  { match: /haiku/i, tokens: 200000 },
  { match: /fable/i, tokens: 200000 },
];

const DEFAULT_WINDOW = 200000;

/**
 * Best-effort context window for a model id string.
 * @param {string} model
 * @returns {number} tokens
 */
function contextWindowForModel(model) {
  if (!model) return DEFAULT_WINDOW;
  for (const { match, tokens } of MODEL_WINDOWS) {
    if (match.test(model)) return tokens;
  }
  return DEFAULT_WINDOW;
}

/**
 * Sum the fields of a usage object that represent tokens the model saw.
 * @param {object} usage
 * @returns {number}
 */
function tokensInUse(usage) {
  if (!usage) return 0;
  const input = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  return input + cacheRead + cacheCreate;
}

/**
 * Read a transcript file and return the live context usage.
 *
 * @param {string} transcriptPath absolute path to a <session-id>.jsonl file
 * @param {object} [opts]
 * @param {number} [opts.contextWindow] override the window size (tokens)
 * @returns {{
 *   ok: boolean,
 *   used: number,
 *   window: number,
 *   ratio: number,        // used / window, 0..1+
 *   percent: number,      // ratio * 100, rounded to 1 decimal
 *   model: string|null,
 *   messages: number,     // assistant turns seen (main thread)
 *   reason?: string       // set when ok === false
 * }}
 */
function readContextUsage(transcriptPath, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    return blank(`cannot read transcript: ${err.code || err.message}`);
  }

  const lines = raw.split(/\r?\n/);
  let lastUsage = null;
  let model = null;
  let assistantTurns = 0;

  // Walk forward so `model` reflects the latest assistant turn; keep the last
  // main-thread usage we encounter as the current context size.
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate truncated / partially-flushed lines
    }
    if (obj.type !== 'assistant') continue;
    if (obj.isSidechain === true) continue; // sub-agent turn: not our window
    const msg = obj.message;
    if (!msg || !msg.usage) continue;
    lastUsage = msg.usage;
    if (msg.model) model = msg.model;
    assistantTurns++;
  }

  if (!lastUsage) {
    return blank('no assistant turns with usage found yet', model);
  }

  const window = opts.contextWindow != null ? opts.contextWindow : contextWindowForModel(model);
  const used = tokensInUse(lastUsage);
  const ratio = used / window;

  return {
    ok: true,
    used,
    window,
    ratio,
    percent: Math.round(ratio * 1000) / 10,
    model: model || null,
    messages: assistantTurns,
  };
}

function blank(reason, model = null) {
  return {
    ok: false,
    used: 0,
    window: DEFAULT_WINDOW,
    ratio: 0,
    percent: 0,
    model,
    messages: 0,
    reason,
  };
}

module.exports = {
  readContextUsage,
  tokensInUse,
  contextWindowForModel,
  MODEL_WINDOWS,
  DEFAULT_WINDOW,
};
