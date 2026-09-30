---
name: muster
description: Run a project as a Herdr space of lanes with Muster 🐑, the project manager on top of Bellwether. Use when Joel says fan out, fan-out, fanout, spin up lanes, lane boss, hawk, desk, judge, or project space, or asks for pane workers, parallel writers, harvests, packet verification, landing lane work, the desk queue, or a weekly project review. This skill holds judgment; the Muster tools enforce the mechanics.
---

# Muster 🐑

One project per Herdr space. Tabs are lanes. Muster's tools own the mechanics: launch profiles, catalog rows, lifecycle states, packet evidence, landing, the desk queue, and sidebar tokens. This skill covers only what the tools cannot decide.

Layers: herdr (terminals) → Bellwether (panes, agents, watches, wakes) → Muster (projects, lanes, packets, agents, desk). Use `herdr_layout overview` for topology; use Muster tools for anything with a lifecycle.

## When to fan out

- Fan out only when the critical path needs a second writer now. Every extra lane costs owner attention and a cold prefix.
- Parallel lanes need disjoint write scopes. One writer per checkout; everyone else reviews a named hash.
- A short fan-out inside an existing space is one lane with the caller as its boss.
- A read-only, headless probe can be a native subagent. Anything that writes, runs long, or needs a restore command is a lane agent.
- A space that serves two outcomes is two projects. Split at the weekly review, not mid-pass.

## How to cut a lane

- Cut by write scope and by one packet that fits the time available. A lane whose packet you cannot name yet is `open: false` (proposed).
- An unready dependency gets a placeholder packet, not a blocked lane.
- The judge reviews the SOP on a slow clock and never sets priorities.
- Briefs live in the project's Brain, never `/tmp`. A brief states the outcome, write scope, checks, and the report rule: commit once, then `packet_report`.

## Shape it to the job

Defaults fit most work. Role models come from the fleet roster (`~/.config/muster/roster.json`); each role lists alternates with what they are for and against. Pick an alternate per lane when the job matches, by passing its model to `agent_launch`. Silence limits default to 30 minutes before a nudge and 60 before a restart. When the job disagrees, change the project with `project_update` rather than working around it. Long builds want longer silence limits or no auto-restart; a cheap scout lane wants a smaller model; a lane that must keep context wants a higher compact-at. An explicit model from Joel wins. `project_update` returns the policy in force.

## The sidebar

- The space label is the project's name. Status never goes there; `project_status` puts a drifted label back.
- The `headline` says what the space is doing now, in under 32 characters. Change it when the story changes, not every pass.
- Joel reads `needs` as the oldest open desk item's title. Title each `desk_post` as his action: "merge #1152", not "PR question".

## What counts as verified

- The intercom report is a claim. `packet_verify` plus the worker's check receipts are the evidence. Screen state, `DONE`, age, or a commit alone are not.
- Record exactly one outcome per packet: committed, rejected, or no_changes.
- Land through `packet_land` with the repo's full gate. One full gate at a time per machine (`muster-heavy -- <cmd>` for workers).
- An artifact packet (remote-machine ops, config, no clone branch) lands by recording: `packet_land` with `evidence`, no merge.
- A customer-facing check counts only when loaded signed out, as the recipient sees it.
- A deploy gate needs a captured base-versus-head surface diff. An allowed-diff list reasoned from code is not evidence.
- Move a rollback target only on CLEAN, and write the verdict line last.

## Escalation

- Reports go up one level: worker to boss, boss to hawk. Workers have no path to Joel.
- A boss answers from source first. Hawk answers or posts one `desk_post` item with the question, evidence, and a recommendation. Nothing is pushed into the desk pane.
- A desk holding several decisions for Joel publishes one [desk report](references/desk-report.md) page, not a chat digest. His pasted feedback goes through `desk_rulings`: each item is resolved, then the owner gets one message.
- Never act on GitHub as Joel. Use the ShitRat bot or ask. "Rerun until green" is not a gate.

## Clocks and cost

- pi-until owns every clock. Keep owner passes under 60 minutes; the prompt cache goes cold after an hour. An empty pass ends in one line.
- Cache reads are most of the cost, and the fixed prefix is about a quarter of them. Give workers only the skills their packet needs.
- The owner's tokens are the scarce resource. Owners verify, land, record, and dispatch; browsing, suites, big diffs, and diagnosis are worker items.

Read [gotchas](references/gotchas.md) when a lane stalls, a bridge lane misbehaves, or a restore surprises you.
