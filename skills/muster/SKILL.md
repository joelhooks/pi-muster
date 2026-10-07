---
name: muster
description: Run a project as a Herdr space of lanes with Muster 🐑, the project manager on top of Bellwether. Use when Joel says fan out, fan-out, fanout, spin up lanes, lane boss, hawk, desk, judge, or project space, or asks for pane workers, parallel writers, harvests, packet verification, landing lane work, the desk queue, stopping the line (freeze, pause everything), or a weekly project review. This skill holds judgment; the Muster tools enforce the mechanics.
---

# Muster 🐑

One project per Herdr space. Tabs are lanes. Muster's tools own the mechanics: launch profiles, catalog rows, lifecycle states, packet evidence, landing, the desk queue, and sidebar tokens. This skill covers only what the tools cannot decide.

Layers: herdr (terminals) → Bellwether (panes, agents, watches, wakes) → Muster (projects, lanes, packets, agents, desk). Use `herdr_layout overview` for topology; use Muster tools for anything with a lifecycle.

## Start here

A project dir must be private, never a public repo's checkout; lanes point `repo` at public code.

No project, no Muster. Before any lane, launch, or `desk_post`, call `project_status`. If it finds no project, call `project_open`: adopt the current space with `space` (or `createSpace: true` for new work), give a kebab-case `slug`, the outcome, and the next action. That registers the project, so the desk queue and the Switchboard can see it. A space with lanes but no project is invisible to Joel. Arm the cadence call `project_open` returns.

## When to fan out

- Fan out only when the critical path needs a second writer now. Every extra lane costs owner attention and a cold prefix.
- Parallel lanes need disjoint write scopes. One writer per checkout; everyone else reviews a named hash.
- A short fan-out inside an existing space is one lane with the caller as its boss.
- A read-only, headless probe can be a native subagent. Anything that writes, runs long, or needs a restore command is a lane agent.
- A space that serves two outcomes is two projects. Split at the weekly review, not mid-pass.
- Work goes to the project whose outcome it serves. Send a request for another project's outcome to that project's desk. A request that smells like a new project, or belongs to a different PARA area, goes up to the Switchboard over intercom with Joel's words and your read of where it belongs. Don't divert your own desk to it, and don't open the project yourself. A shared platform's desk keeps main and the deploy gate; tenant desks own their asks and cut lanes with `repo` pointing at the platform. drovr lost 30 hours on its own outcome running another tenant's deploys.

## Side desks

Use a side desk when Joel wants to explore an evolving design alongside the main conversation. Fork it with `agent_launch action=fork from=<desk row> side=true name=<name> label=<emoji + words>`; it shares the parent's desk tab. Keep execution with the parent desk: the side desk writes briefs and decision notes and hands them over intercom. For a running desk already moved into that tab, use `action=adopt` with `name`, `from`, `side=true`, and the parent's `lane`; adoption changes the catalog, not the pane. Deliver the returned fence in its next conversation turn.

## How to cut a lane

- A lane is a feature. Its boss owns the feature end to end: it plans the packets, lands them, and closes the lane when the feature ships. A lane whose outcome you cannot name yet is `open: false` (proposed).
- Inside a lane, cut packets by write scope and by what fits the time available.
- A one-packet fix can run without a boss. Its worker reports to whoever opened the lane.
- An unready dependency gets a placeholder packet, not a blocked lane.
- A release that spans code and live config splits at the start: code, config, and early review as disjoint lanes, one writer per checkout, one combined release packet. The final integrated gate still runs. drovr split at hour five; it could have split at hour zero.
- The judge reviews the SOP on a slow clock and never sets priorities.
- Briefs live in the project's Brain, never `/tmp`. Use the [done and brief template](references/done.md#brief-template): outcome, write scope, checks, deploy, live proof, signals, and the report rule. [Brief patterns](references/briefs.md) says what makes each section work.

## Keep work flowing

The WIP limit is the owner's target, not just a ceiling. Keep ready work at the limit; use `kind: "retro"` for the judge's standing slot outside work WIP. Read-only reviewers and judges don't take a pull slot (Joel, 2026-10-06): open them as `kind: "role"` lanes with `role: "judge"` agents and no clone, or launch them inside the lane they review. A role lane that lands commits is a work lane in disguise. When a lane is proven or closed and a slot opens, pull the top of the backlog. Use the project's deploy posture to decide how much proof the work needs.

The desk keeps the backlog shaped: ranked proposed work lanes with briefs. Lower ranks go first; creation time breaks ties, and unranked lanes follow ranked ones. Park work with `lane_open open: false`. Re-rank proposed work with `rank`; Joel orders the backlog when he wants to.

Use median cycle time over the last ten proven lanes and throughput over the last seven days to judge flow. Lanes are continuous work, not sprints.

After three closed work lanes and at every `project_review`, dispatch a short-lived judge using [finished-lane retro](references/retro.md). Record its artifact, route its findings into ranked backlog lanes, then mark the retro done with `project_review` `retro: true`.

Deploy posture belongs in the project's VISION.md, in Joel's words. Choose the least permission the work needs: customer-facing work, money, outbound sends and slow rollbacks stay conservative; irreversible work needs approval. A research experiment can ship and watch, or skip proof when its rollback is cheap. Tools enforce the declared level; check watching lanes at retro.

## Shape it to the job

Say `opus` or `sol` for a model, never a provider prefix. Fable is off fleet-wide. Sonnet only where Joel named it: front-desk, and `claude-bridge/claude-sonnet-5-5` as an explicit, exploratory worker choice.

Defaults fit most work. Role models come from the fleet roster (`~/.config/muster/roster.json`); each role lists alternates with what they are for and against. Pick an alternate per lane when the job matches, by passing its model to `agent_launch`. Silence limits default to 30 minutes before a nudge and 60 before a restart. When the job disagrees, change the project with `project_update` rather than working around it. Long builds want longer silence limits or no auto-restart; a cheap scout lane wants a smaller model; a lane that must keep context wants a higher compact-at. An explicit model from Joel wins. `project_update` returns the policy in force.

Roster skills are a role's standing set; name extras at launch; workers pull the rest with `skill_find` and read matching `SKILL.md` files.

## Asynchronous launches

`agent_launch` with `launch`, `fork`, or `restore` returns a job receipt, not a live agent. Wait for its owner-queue action before arming `herdr_watch` on the returned pane. A `blocked` result names the failure and log; inspect it before retrying. `adopt` and `restart` keep their existing behavior.

## Warm forks and rewind

After a dependency upgrade, restart Pi with `pi --session <session file>`, not `/reload`; the running process keeps the old dependency modules cached.

Workers mark `ctx:ready` with `context_mark` once the code they need is read, before editing. Fork related work with `agent_launch action=fork from=<row> at=ctx:ready`, a fresh name and its own brief; use `clone: true` for an independent checkout. Omitting `at` keeps the full-session fork.

When an instruction is overruled, use `agent_rewind name=<worker> to=<label or entry id> note=<correction>` rather than stacking an “ignore that” message. Wait for verified branch evidence, then send the corrected instruction as usual. Rewind changes conversation context, not files or commits.

## Callsigns

Every live agent wears `<emoji> <Callsign> · <role>` on its pane and session name. Each project picks one theme from a weird, obscure pop-culture deep cut (cult TV, forgotten cartoons, B-movies, prog-rock sleeves, 80s toy lines, defunct game shows), not a blockbuster franchise. Callsigns are one word and unique across the fleet. Read `~/.local/state/switchboard/callsigns.jsonl` before claiming. Claim by appending one line per agent (`at`, `project`, `theme`, `callsign`, `emoji`, `agent`, `pane`); to drop a name, append `{"at","project","released":"<Callsign>"}`, and never rewrite lines. `agent_launch` uses a row's claim as its label when `label` is omitted. Callsigns are display only: row names, Herdr agent names, session ids, lane slugs and tab labels stay as they are, because they're routing.

## The sidebar

- The space label is the project's name. Status never goes there; `project_status` puts a drifted label back.
- The `headline` says what the space is doing now, in under 32 characters. Change it when the story changes, not every pass.
- Joel reads `needs` as the oldest open desk item's title. Title each `desk_post` as his action: "merge #1152", not "PR question".

## What counts as verified

`muster-heavy` is on PATH in Muster-launched agents and the loaded owner's shell; otherwise run `node <pi-muster>/bin/muster-heavy.ts`.

Read [done means live and proven](references/done.md) when cutting a brief or finishing delivery. Merged is not live.

- The owner-queue packet report is a claim. `packet_verify` plus the worker's check receipts are the evidence. Screen state, `DONE`, age, or a commit alone are not.
- Record exactly one outcome per packet: committed, rejected, or no_changes.
- With Bellwether's pane-close bus support, `agent_close` and `lane_close` retire the owner's matching watches before closing; no manual blocked-watch cancellation is needed. Older Bellwether still needs `herdr_watch action=cancel` first. Inspect named targets as well as pane targets; fallback receipts list only candidates.
- In `pr-merge` projects, hold a PR with `shitrat convert-to-draft <owner/repo> <n>` (it also leaves the merge queue) or `shitrat label <owner/repo> <n> --add 'NO MERGE'`, and post gate results with `shitrat set-status`. Never use `gh` for these; all three act as shitratgit[bot] and take `--dry-run`.
- Land through `packet_land` with the repo's full gate (`muster-heavy gate --wait 1200 -- <cmd>` for workers and owner checks; deploy window and grant unset). Fleet-compute owns routing and queueing. Use `--host flagg` for host-bound checks; keep `pack:check` and `smoke` local. Local `muster-heavy -- <cmd>` registers and runs immediately, without admission or exclusive holds. See [gotchas](references/gotchas.md#heavy-jobs-and-fleet-gates) for telemetry and compatibility.
- An artifact packet (remote-machine ops, config, no clone branch) lands by recording: `packet_land` with `evidence`, no merge.
- A customer-facing check counts only when loaded signed out, as the recipient sees it.
- A deploy gate needs a captured base-versus-head surface diff. An allowed-diff list reasoned from code is not evidence.
- Move a rollback target only on CLEAN, and write the verdict line last.

## Escalation

- Reports go up one level: worker to boss, boss to hawk. Workers have no path to Joel.
- A boss answers from source first. Hawk answers or posts one `desk_post` item with the question, evidence, and a recommendation. Nothing is pushed into the desk pane.
- When Joel delegates an operation ("take charge"), record the scope in the handoff. Within it, the desk rules on execution choices from source and sends one ruling to the owning lane, never the same question back to Joel. A new class of risk goes to Joel: customer sends beyond the approval, broader production code, durability changes, deletion. A delegated desk never turns a failed gate into a pass.
- When Joel stops the line (a freeze with only essentials and monitoring), the desk runs [stop the line](references/stop-the-line.md). Hawk stays standing: it drops to low thinking, or a fresh third-shift Hawk takes over. Only Joel resumes.
- A desk holding several decisions for Joel publishes one [desk report](references/desk-report.md) page, not a chat digest. His pasted feedback goes through `desk_rulings`: each item is resolved, then the owner gets one message.
- The Switchboard uses `desk_phone` for rats-nest only: send one report card with marked suggestions, poll its private pending map, and sync recorded phone rulings or threads resolved elsewhere; its existing network consumer owns all answers and the single DID lease.
- Never act on GitHub as Joel. Use the ShitRat bot or ask. "Rerun until green" is not a gate.

## Talking across lanes and desks

Messages must be plain sentences with spaces between words; put code, paths and ids in backticks.

- Workers and bosses post FYI, progress and done with `owner_note`; these accumulate without waking their owner. A blocking question uses `owner_note kind=question`. `packet_report` remains the one finish report.
- Answer a queued question with `owner_reply`, naming its URI. Replies thread back to the author and mention them, so their feed wakes when idle. Owners pull `owner_inbox` for records and use `ack` only for items they have handled.
- Intercom ask/reply is for live back-and-forth, not progress pings. Older or unavailable queue readers still receive an intercom fallback for mentions.

- Bosses talk to each other directly over intercom about interfaces, shared files, and ordering. A boss never writes in another lane's scope.
- A decision two lanes share gets one line in the project's Brain, so neither boss holds it alone. Bosses who disagree take it to the hawk, not to Joel.
- Muster resolves `<project slug>/<agent row name>` through its Comms port at send time, so a restore or `/new` does not strand the alias. Raw intercom calls still need the live session id from `project_status`, never a launch name. `MUSTER_COMMS` overrides project policy `comms`; the default is intercom. Network delivery fails closed until implemented. Intercom ask/reply through the port are unsupported, and wake reports that intercom has no wake.
- Rat King schemas and native decoded types come from the hash-pinned generated lexicon vendored at `0e895a3`; never hand-edit vendor files. Network delivery and the private lease authority refuse calls. DID routing requires local alias resolution and an explicit harness session adapter; ack carries `leaseId` and `generation`. Wake is separate, and `signed` stays opaque until golden crypto vectors exist.
- A desk asks another project's desk for anything that project owns, such as a Muster bug or a tool gap. Open the message with sender and receiver (`💬 drovr desk → 💬 muster desk`). Include one concrete ask, the receipt paths, and what you already ruled out.
- The receiving desk acks, lanes the work or says no with the reason, and messages back when it ships with the steps the asker needs. Nobody hand-edits another project's catalog.
- Touch another project's pane only when the session in it asks, and only for what it asked, such as a keypress it can't send mid-turn.
- Questions for Joel go through your own project's `desk_post`, never through another desk.

## Clocks and cost

- pi-until owns every clock. Keep owner passes under 60 minutes; the prompt cache goes cold after an hour. An empty pass ends in one line.
- Cache reads are most of the cost, and the fixed prefix is about a quarter of them. Give workers only the skills their packet needs.
- The owner's tokens are the scarce resource. Owners verify, land, record, and dispatch; browsing, suites, big diffs, and diagnosis are worker items.

For worker panes on a saved machine, read [remote lanes](references/remote-lanes.md) for configuration, prerequisites and recovery. The desk and landings stay on the owner machine.

Read [gotchas](references/gotchas.md) when a lane stalls, a bridge lane misbehaves, or a restore surprises you.
