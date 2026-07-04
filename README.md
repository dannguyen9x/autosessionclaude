# autosession — automatic context handoff for Claude Code

When a Claude Code session's **context window fills up**, you normally either lose
detail to `/compact` or start over and re-explain everything. **autosession** does
it for you: it watches context usage, and at ~90% it writes a **self-contained
handoff** of everything that happened, then **auto-loads that handoff into a fresh
session** so the work continues without missing a beat.

It ships as two cooperating pieces:

| Piece | What it does | For |
| --- | --- | --- |
| **Plugin** (hooks) | Watches every turn. At the threshold it makes the current session write a handoff, and injects that handoff into the next session automatically. | Interactive use — you're driving Claude Code yourself. |
| **`autosession` CLI** | Runs a task *fully unattended*, spawning session after session and carrying the handoff across each, until the task is done. | Autonomous, long-running tasks. |

Both are **zero-dependency Node.js** and work on Windows, macOS, and Linux.

---

## How it works

autosession reads context usage straight from Claude Code's own transcript
(`~/.claude/projects/<project>/<session-id>.jsonl`). The tokens the model is
currently holding =
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the
last main-thread assistant turn. Divided by the model's context window (200k for
Opus/Sonnet/Haiku), that's your live "% full".

### Interactive mode (the plugin)

```
turn ends
   │
   ▼
Stop hook ──▶ read transcript ──▶ context ≥ 90%?
   │                                   │ yes (once per session)
   │ no                                ▼
   └▶ do nothing         decision:"block" → Claude writes a complete
                          handoff to .autosession/latest-handoff.md, then stops
                                              │
              you /clear or open a new session in this directory
                                              │
                                              ▼
                          SessionStart hook injects the handoff as context
                          (and as the first message in headless -p mode)
                                              │
                                              ▼
                              fresh session continues the work
```

### Autonomous mode (the CLI)

```
autosession run "big task"
   │
   ▼
┌─▶ claude -p "<task | handoff>"  ──▶  finished? (prints sentinel) ──▶ ✅ done
│        │                                        │ no
│        ▼                                        ▼
│   read new transcript ── context ≥ 90% ? ──┬── yes ─▶ summarise → fresh session ─┐
│                                            └── no  ─▶ --resume same session ──────┤
└────────────────────────────────────────────────────────────────────────────────┘
        (guards: max sessions, max cost, completion sentinel)
```

---

## Install

### Option A — as a Claude Code plugin (recommended for interactive use)

```
/plugin marketplace add dannguyen9x/autosessionclaude
/plugin install autosession@autosessionclaude
```

That's it. The plugin's hooks are now active in every session. Try it: work until
you approach the context limit, or run `/autosession:handoff` any time to force a
handoff. (The marketplace has no pinned `version`, so `/plugin update` picks up new
commits automatically.)

### Option B — the CLI (for autonomous runs)

Clone and link the CLI:

```bash
git clone https://github.com/dannguyen9x/autosessionclaude
cd autosessionclaude
npm link          # puts `autosession` on your PATH  (or: node bin/autosession.js …)
```

Requires the `claude` CLI to be installed and on your PATH. If it isn't found, set
`AUTOSESSION_CLAUDE_BIN` (e.g. `claude.cmd` on Windows).

### Option C — manual hooks (no marketplace)

Copy the hook entries from [`examples/settings-hooks.example.json`](examples/settings-hooks.example.json)
into your `.claude/settings.json`, replacing the placeholder path with where you
cloned this repo.

---

## Usage

### Check how full you are

```bash
autosession status
```

```
  autosession — context usage
  [████████████████████████░░░░░░] 80.8% of 200,000 tokens
  used: 161,658 tokens   model: claude-opus-4-8   turns: 82
  threshold: 90%  ->  ok
```

### Force a handoff (in Claude Code)

```
/autosession:handoff
```

Claude writes a full handoff to `.autosession/latest-handoff.md`. `/clear` or open a
new session and it resumes automatically.

### Run a task autonomously

```bash
autosession run "Refactor the auth module into services/ and add unit tests" --dangerous --model opus
```

`--dangerous` uses `bypassPermissions` so the run doesn't stall on approval prompts
(required for unattended file edits — see **Safety** below). autosession keeps
spawning sessions, handing off context whenever it fills, until Claude prints the
completion sentinel or a guard trips.

### Diagnose

```bash
autosession doctor      # node/claude versions, detected transcript, resolved config
```

---

## Configuration

Set via `<project>/autosession.config.json` (see
[`autosession.config.example.json`](autosession.config.example.json)) or `AUTOSESSION_*`
environment variables. Env wins.

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `threshold` | `AUTOSESSION_THRESHOLD` | `0.9` | Handoff when usage reaches this (accepts `0.9` or `90`). |
| `contextWindow` | `AUTOSESSION_CONTEXT_WINDOW` | auto | Override the model window in tokens. |
| `claudeBin` | `AUTOSESSION_CLAUDE_BIN` | `claude` | The Claude Code executable. |
| `model` | `AUTOSESSION_MODEL` | inherit | `opus`/`sonnet`/`haiku`/`fable` or a full id. |
| `maxSessions` | `AUTOSESSION_MAX_SESSIONS` | `20` | Hard cap on chained sessions per run. |
| `maxTurnsPerSession` | `AUTOSESSION_MAX_TURNS` | ∞ | `--max-turns` for each session. |
| `maxCostUsd` | `AUTOSESSION_MAX_COST` | ∞ | Stop the run once total cost hits this. |
| `completionSentinel` | `AUTOSESSION_COMPLETION_SENTINEL` | `<<<AUTOSESSION_TASK_COMPLETE>>>` | Token the model prints as its final line when fully done. |
| `permissionMode` | `AUTOSESSION_PERMISSION_MODE` | `default` | Permission mode for spawned sessions. |

CLI flags on `run` (`--threshold`, `--max-sessions`, `--max-turns`, `--max-cost`,
`--model`, `--permission-mode`, `--dangerous`) override config.

---

## Safety & guardrails

Autonomous mode spawns real Claude sessions that spend tokens and can edit files.
autosession is built to fail safe:

- **Completion sentinel** — the loop only ends "successfully" when the model prints
  the exact sentinel line; it never assumes it's done.
- **`maxSessions`** — a hard ceiling (default 20) so a task that never finishes
  can't loop forever.
- **`maxCostUsd`** — optional dollar cap; the run stops once accumulated
  `total_cost_usd` reaches it.
- **Explicit opt-in for autonomy** — unattended editing needs
  `--dangerous`/`bypassPermissions`. Without it the runner warns that sessions may
  stall on permission prompts, and continues in safe mode.
- **Hooks fail open** — the Stop/SessionStart hooks wrap everything in try/catch and
  exit 0 on any error, so a bug in autosession can never break a real session. The
  one intentional exception is the single, guarded `decision:block` per session.
- **The handoff is written by the session that has full context**, so it's the most
  accurate summary possible — not a lossy after-the-fact reconstruction.

---

## Repo layout

```
.claude-plugin/
  plugin.json           plugin manifest (name only required; version omitted → git-SHA updates)
  marketplace.json      one-repo marketplace; plugin source "./"
hooks/
  hooks.json            registers the Stop + SessionStart hooks
  stop-check-context.js Stop hook — detect threshold, trigger handoff
  session-start.js      SessionStart hook — inject + consume the handoff
commands/
  handoff.md            /autosession:handoff slash command
lib/
  context-usage.js      transcript → live context %
  paths.js              locate transcripts & .autosession state
  config.js             config precedence & coercion
  handoff.js            summariser prompt + handoff file I/O
  claude-runner.js      spawn `claude -p`, parse JSON result
bin/
  autosession.js        CLI: status / run / handoff / doctor
templates/handoff-template.md
examples/settings-hooks.example.json
test/run.js             zero-dependency test suite (npm test)
```

---

## Limitations & notes

- Context window sizes are heuristic per model (200k default; override with
  `contextWindow`). If you use a 1M-context beta, set it explicitly.
- The transcript JSONL schema is read empirically (Claude Code doesn't formally
  document it); the reader tolerates unknown/missing fields.
- In interactive mode, starting the next session is still your action (`/clear` or a
  new window) — that's inherent to interactive use. The plugin automates the
  summarise + reload around it. Full end-to-end automation is the `autosession run`
  CLI.
- Firing at 90% intentionally beats Claude Code's own auto-compact so you get a
  fresh-session handoff instead of an in-place compaction.

## License

MIT © dannguyen9x
