# AGENTS.md

Shared by Codex, Claude Code, Cursor agents, and staff bots that touch code.
Every line here should change what you do. Add, cut, and reorganize freely.
Vault Global (locks, voice, format) wins on conflict. Do not copy locks into this file.
Also read `docs/PROJECT.md` when it exists. It holds this repo's own notes.

## Lead with what you need from me
When a long task is done, or you're stuck and need me to do something, put that list at the very top of your reply (before anything else). One thing per item, numbered. Spell out what I should do, where, and what to send back when I'm done, e.g. "Log into Stripe, export the September refunds CSV, put it in inbox/". Worst blocker first. If you need nothing from me, say so, then lead with the answer.

## How we talk (coding sessions)
- First line is the answer: yes/no, number, link, or the ask. No preamble. No recap at the bottom.
- One question at a time, short. Skipped usually means I missed it, not no. Bring it back later.
- If you must wait on me: state a default and when. Do not treat silence as yes. Park reversible work; never merge, send, spend, or delete on a default. Re-ask once, short, through Patton if you're a staff bot.
- Non-obvious or fleet-wide change: show the recommendation first. Clear yes before you ship it.
- No title or heading may start with "The".

Staff channel habits (Hemingway, Slack threads, combined client done messages) live in vault `global/channels/`, not here.

## Plan before you touch code
- Long task: 2-3 sentences on the goal, then start. Skip for routine one-shots.
- Steps in `PLAN.md` or your lane's `STATUS.md`. Each step says how you'll prove it.
- Fail twice → stop, name the cause, re-plan.
- If you pause, leave the plan file current so the next session can resume.

## Smallest change that works
- Only the task asked. Don't break nearby features to "improve" them.
- Weigh UX, DX, and AX (how agents maintain this later).
- No new dependencies, renames, or refactors unless I asked.
- Before delete or overwrite, keep a recoverable copy or version.

## Own the bug
- Reproduce with my steps first. No fix until you see it fail.
- After the root-cause fix, run the same steps again.
- Never silence an error just to hide the symptom.

## Verify before you say done
- Run the checks that matter; read the output yourself.
- UI: try to break it (empty input, double submit, refresh, bad state).
- A check you didn't run is not a pass. Say what you skipped.
- Close with 2-3 lines: what changed and why.

## Split work when it helps
- One job per helper: clear done condition, short report.
- Parallel is fine; two helpers must not edit the same file at once.
- Verify a helper's claims before you build on them.
- Use the harness you have. Don't invent role names that don't exist here.

## Approvals
- Clear yes ("send", "ship it", "do it", "go") means do that ask. No second confirm.
- Separate explicit OK still required for money, delete/destroy, legal/signatures, and anything irreversible beyond an approved draft send.
- Merges and secrets: follow vault Global / staff policy. Bots don't invent merge rights from this file.

## Write down every correction
- Same turn, under Lessons: `When X, do Y`. Newest on top. Cap at 20; delete stale ones.
- Same mistake twice → rewrite the lesson.
- Ask me before changing any rule above Lessons.
- Staff bots also log the staff corrections path.

## Lessons
<!-- Newest on top. Max 20. Delete what no longer applies. -->

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
