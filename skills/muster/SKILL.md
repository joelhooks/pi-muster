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
- Work goes to the project whose outcome it serves. Send a request for another project's outcome to that project's desk. If no project owns it, `project_open` one instead of cutting a lane in your own space. A shared platform's desk keeps main and the deploy gate; tenant desks own their asks and cut lanes with `repo` pointing at the platform. drovr lost 30 hours on its own outcome running another tenant's deploys.

## How to cut a lane

- A lane is a feature. Its boss owns the feature end to end: it plans the packets, lands them, and closes the lane when the feature ships. A lane whose outcome you cannot name yet is `open: false` (proposed).
- Inside a lane, cut packets by write scope and by what fits the time available.
- A one-packet fix can run without a boss. Its worker reports to whoever opened the lane.
- An unready dependency gets a placeholder packet, not a blocked lane.
- A release that spans code and live config splits at the start: code, config, and early review as disjoint lanes, one writer per checkout, one combined release packet. The final integrated gate still runs. drovr split at hour five; it could have split at hour zero.
- The judge reviews the SOP on a slow clock and never sets priorities.
- Briefs live in the project's Brain, never `/tmp`. A brief states the outcome, write scope, checks, and the report rule: commit once, then `packet_report`.

## Shape it to the job

Say `opus`, `fable`, or `sol` for a model, never a provider prefix.

Defaults fit most work. Role models come from the fleet roster (`~/.config/muster/roster.json`); each role lists alternates with what they are for and against. Pick an alternate per lane when the job matches, by passing its model to `agent_launch`. Silence limits default to 30 minutes before a nudge and 60 before a restart. When the job disagrees, change the project with `project_update` rather than working around it. Long builds want longer silence limits or no auto-restart; a cheap scout lane wants a smaller model; a lane that must keep context wants a higher compact-at. An explicit model from Joel wins. `project_update` returns the policy in force.

Roster skills are a role's standing set; name extras at launch; workers pull the rest with `skill_find` and read matching `SKILL.md` files.

## The sidebar

- The space label is the project's name. Status never goes there; `project_status` puts a drifted label back.
- The `headline` says what the space is doing now, in under 32 characters. Change it when the story changes, not every pass.
- Joel reads `needs` as the oldest open desk item's title. Title each `desk_post` as his action: "merge #1152", not "PR question".

## What counts as verified

- The owner-queue packet report is a claim. `packet_verify` plus the worker's check receipts are the evidence. Screen state, `DONE`, age, or a commit alone are not.
- Record exactly one outcome per packet: committed, rejected, or no_changes.
- With Bellwether's pane-close bus support, `agent_close` and `lane_close` retire the owner's matching watches before closing; no manual blocked-watch cancellation is needed. Older Bellwether still needs `herdr_watch action=cancel` first. Inspect named targets as well as pane targets; fallback receipts list only candidates.
- Land through `packet_land` with the repo's full gate (`muster-heavy --wait 1200 -- <cmd>` for workers, window unset). Short deploys use `MUSTER_DEPLOY_WINDOW=<deploy-id> muster-heavy --wait 1200 -- <cmd>` for the extra reserved `deploy-0` slot, capped at five minutes; ordinary gates never use it. Only one priority holder runs at once: deploys wait on another deploy, exclusive holds or memory pressure, not gates. Add `--exclusive` only when the deploy must drain and hold every slot, including `deploy-0` (20-minute cap). Never borrow a deploy window for ordinary gates. For a few named critical-path gates, the desk can issue `muster-heavy grant <label> --ttl 1h`; workers use `MUSTER_HEAVY_GRANT=<id>` and must not grant themselves. Grants are self-issued on a single-user machine, bounded by four live grants, a two-hour maximum TTL and audit. They reorder the queue behind deploys and ahead of ordinary gates, but add no capacity or pressure bypass: shedding load is still the fix for saturation. See [gotchas](references/gotchas.md#heavy-gates-and-deploy-windows) for limits and audit.
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
- Never act on GitHub as Joel. Use the ShitRat bot or ask. "Rerun until green" is not a gate.

## Talking across lanes and desks

- Workers and bosses post FYI, progress and done with `owner_note`; these accumulate without waking their owner. A blocking question uses `owner_note kind=question`. `packet_report` remains the one finish report.
- Answer a queued question with `owner_reply`, naming its URI. Replies thread back to the author and mention them, so their feed wakes when idle. Owners pull `owner_inbox` for records and use `ack` only for items they have handled.
- Intercom ask/reply is for live back-and-forth, not progress pings. Older or unavailable queue readers still receive an intercom fallback for mentions.

- Bosses talk to each other directly over intercom about interfaces, shared files, and ordering. A boss never writes in another lane's scope.
- A decision two lanes share gets one line in the project's Brain, so neither boss holds it alone. Bosses who disagree take it to the hawk, not to Joel.
- Address intercom by the session id `project_status` shows (`intercom=reachable@<id>`), never by a catalog or launch name. A restore or `/new` changes the id, and intercom queues mail for a dead name while still saying "Message sent".
- A desk asks another project's desk for anything that project owns, such as a Muster bug or a tool gap. Open the message with sender and receiver (`💬 drovr desk → 💬 muster desk`). Include one concrete ask, the receipt paths, and what you already ruled out.
- The receiving desk acks, lanes the work or says no with the reason, and messages back when it ships with the steps the asker needs. Nobody hand-edits another project's catalog.
- Touch another project's pane only when the session in it asks, and only for what it asked, such as a `/reload` it can't run mid-turn.
- Questions for Joel go through your own project's `desk_post`, never through another desk.

## Clocks and cost

- pi-until owns every clock. Keep owner passes under 60 minutes; the prompt cache goes cold after an hour. An empty pass ends in one line.
- Cache reads are most of the cost, and the fixed prefix is about a quarter of them. Give workers only the skills their packet needs.
- The owner's tokens are the scarce resource. Owners verify, land, record, and dispatch; browsing, suites, big diffs, and diagnosis are worker items.

Read [gotchas](references/gotchas.md) when a lane stalls, a bridge lane misbehaves, or a restore surprises you.
