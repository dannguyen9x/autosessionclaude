'use strict';

/**
 * claude-runner.js — spawn the `claude` CLI in headless (`-p`) mode and parse
 * its JSON result.
 *
 * The prompt is always delivered on STDIN (never as a shell argument), so there
 * is no command-injection surface even though we use shell:true on Windows to
 * resolve `claude.cmd`. Every other argument is a fixed flag or a validated
 * value (a model alias, a UUID, an integer, an enum), so it is safe to pass
 * through the shell.
 */

const { spawn } = require('child_process');

/**
 * Quote a single token for a shell command string. We run through the platform
 * shell (shell:true) so that `claude.cmd` resolves on Windows; passing ONE
 * command string (rather than an args array) avoids Node's DEP0190 warning.
 * None of these tokens carry the user's prompt — that goes on stdin — so the
 * only reason to quote is paths/values that may contain spaces or shell
 * metacharacters (legal in Windows paths, e.g. `C:\R&D\proj`).
 *
 * Quoting differs by shell: cmd.exe (Windows shell:true) doesn't understand
 * POSIX backslash escapes and treats `"..."` contents literally, so we wrap and
 * double any embedded quotes; POSIX sh uses single-quote wrapping.
 */
const isWindows = process.platform === 'win32';

function shQuote(token) {
  const s = String(token);
  if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s; // safe as-is on every shell
  if (isWindows) {
    // cmd.exe: wrap in double quotes; a literal " becomes "".
    return '"' + s.replace(/"/g, '""') + '"';
  }
  // POSIX: single-quote wrap; close-quote, escaped-quote, reopen for any '.
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildCommand(bin, argv) {
  return [bin, ...argv].map(shQuote).join(' ');
}

/**
 * @typedef {Object} RunResult
 * @property {boolean} ok            process exited 0 and (if JSON) not is_error
 * @property {string}  resultText    the assistant's final text
 * @property {string|null} sessionId session id reported by claude, if any
 * @property {number}  costUsd       total_cost_usd for this invocation
 * @property {number}  exitCode
 * @property {string}  stderr
 * @property {object|null} raw        parsed JSON result object, if parseable
 */

/**
 * Run `claude -p` once.
 *
 * @param {object} args
 * @param {string} args.promptText   sent on stdin
 * @param {string} args.cwd
 * @param {string} args.claudeBin    executable name/path (default "claude")
 * @param {string|null} [args.model]
 * @param {string|null} [args.permissionMode]
 * @param {string|null} [args.resume]        session id to --resume
 * @param {number|null} [args.maxTurns]
 * @param {string[]}    [args.extraArgs]     additional fixed flags
 * @param {(chunk:string)=>void} [args.onStderr] live stderr sink
 * @returns {Promise<RunResult>}
 */
function runClaude(args) {
  const {
    promptText,
    cwd,
    claudeBin = 'claude',
    model = null,
    permissionMode = null,
    resume = null,
    maxTurns = null,
    extraArgs = [],
    onStderr = null,
  } = args;

  const argv = ['-p', '--output-format', 'json'];
  if (model) argv.push('--model', model);
  if (permissionMode) argv.push('--permission-mode', permissionMode);
  if (resume) argv.push('--resume', resume);
  if (maxTurns) argv.push('--max-turns', String(maxTurns));
  if (cwd) argv.push('--add-dir', cwd);
  argv.push(...extraArgs);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(buildCommand(claudeBin, argv), {
        cwd,
        shell: true, // resolve claude/claude.cmd via the platform shell
        windowsHide: true,
      });
    } catch (err) {
      resolve(fail(-1, `spawn failed: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';

    child.on('error', (err) => {
      // e.g. ENOENT when claude is not installed / not on PATH
      resolve(fail(-1, `cannot launch "${claudeBin}": ${err.message}`));
    });
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });

    child.on('close', (code) => {
      const parsed = parseResult(stdout);
      const ok = code === 0 && !(parsed && parsed.is_error === true);
      resolve({
        ok,
        resultText: parsed ? String(parsed.result ?? parsed.text ?? '') : stdout.trim(),
        sessionId: parsed ? parsed.session_id || parsed.sessionId || null : null,
        costUsd: parsed ? Number(parsed.total_cost_usd || parsed.cost_usd || 0) : 0,
        exitCode: code,
        stderr,
        raw: parsed,
      });
    });

    // Deliver the prompt on stdin, then close it so claude starts.
    child.stdin.on('error', () => {}); // ignore EPIPE if the child died early
    child.stdin.write(promptText);
    child.stdin.end();
  });

  function fail(code, msg) {
    return { ok: false, resultText: '', sessionId: null, costUsd: 0, exitCode: code, stderr: msg, raw: null };
  }
}

/** Best-effort parse of `--output-format json` stdout (one JSON object). */
function parseResult(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some versions may emit trailing logs; grab the last {...} block.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Check whether `claude` is reachable; resolves to its version string or null. */
function claudeVersion(claudeBin = 'claude') {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(buildCommand(claudeBin, ['--version']), { shell: true, windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.on('error', () => resolve(null));
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

module.exports = { runClaude, claudeVersion, parseResult };
