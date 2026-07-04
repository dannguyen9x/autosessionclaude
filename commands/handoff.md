---
description: Write a complete session handoff so a fresh Claude Code session can continue this work. autosession auto-loads it on the next session start.
argument-hint: "[optional extra notes to include]"
allowed-tools: Read, Write, Bash(git status:*), Bash(git log:*)
---

Create a **session handoff** for this project so that a brand-new Claude Code
session — with none of the current context — can pick up and continue seamlessly.

Write the handoff to `./.autosession/latest-handoff.md` (create the `.autosession`
directory if needed). autosession's SessionStart hook will auto-load this file the
next time a session starts in this directory (e.g. after `/clear` or opening a new
session), so make it **complete and self-contained** — it is the only memory the
next session will have.

Fill in **every** section below with concrete, specific detail (real file paths,
real commands, real decisions). Do not invent progress that did not happen. Omit
these instructions from the output file.

```markdown
# 🤝 Session Handoff

## 1. Original goal
<the task the user originally asked for — the real intent, one short paragraph>

## 2. Done so far
<bulleted, concrete list of what is actually completed and verified: files
created/edited, commands run, decisions made, tests passing>

## 3. Current state
<where things stand right now; what is half-done; working dir / branch / running
processes; anything in-flight>

## 4. Key files & locations
<the handful of paths that matter, each with a one-line note on its role>

## 5. Decisions, constraints & gotchas
<non-obvious choices already made and why; things that were ruled out; environment
quirks; conventions to follow — so the next session doesn't repeat mistakes>

## 6. Next steps
<ordered, concrete actions to take, starting from the immediate next one>

## 7. Done criteria
<how to know the whole task is complete>
```

If the user passed extra notes, incorporate them: $ARGUMENTS

After writing the file, confirm to the user that the handoff is ready and that they
can run `/clear` or open a new session in this directory to continue automatically.
