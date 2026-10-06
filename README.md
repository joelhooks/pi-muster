# Muster 🐑

Muster is the project manager for Herdr project spaces in Pi. A project is one Herdr space. A lane is one tab. An agent is a catalog row with a full launch profile. A packet is one harvested result named by its hash. The desk is the operator's queue.

It sits on top of [Bellwether](https://github.com/joelhooks/pi-bellwether), which owns the generic Herdr runtime: sockets, panes, agents, watches, wakes. Muster imports Bellwether's exported modules as a library and never reaches into its extension. Bellwether never imports Muster.

```text
herdr (terminals) → Bellwether (runtime) → Muster (projects, lanes, packets, agents, desk)
```

## Install

```bash
pi install git:github.com/joelhooks/pi-muster
```

Muster expects [Herdr](https://herdr.dev), pi-intercom, and pi-until in the same Pi install. Two paths default to the author's rig and can be pointed elsewhere:

- `MUSTER_WORKER_WORKTREE`: the script that allocates, harvests, and removes worker clones.
- `MUSTER_DESK_EXTENSION`: the Pi extension a desk agent loads to read its queue.

## Long-lived sessions

Muster records the package commit when the extension loads, without spawning Git. Every tool, including desk and Switchboard tools, checks for changes at most once per minute. A changed commit adds a stale-tools warning with both short SHAs and the commit count when Git can calculate it. `project_status` also marks its board header. After a dependency upgrade, restart Pi with `pi --session <session file>`, not `/reload`: stale reloads keep Muster tool names and return the restart command instead of silently losing them. Source-only changes can use `/reload`; Claude bridge sessions need a restart.

Outside a Git checkout, the check uses the package version and newest mtime of the extension's local source imports. Missing metadata or a failed check never blocks a tool. Startup reads version metadata only; it opens no socket or bus channel.

## Roster

Role models are data. Muster reads `~/.config/muster/roster.json` (or `MUSTER_ROSTER`) on every call, so one edited and synced file changes what every machine launches next. Without it, built-in defaults apply. Precedence: built-in, roster role, the alternate matching the chosen model, project policy, explicit `agent_launch` arguments.

```json
{
  "version": 1,
  "aliases": {
    "opus": "claude-bridge/claude-opus-5-5",
    "sol": "openai-codex/gpt-6.1-sol"
  },
  "roles": {
    "boss": {
      "model": "claude-bridge/claude-opus-5-5",
      "alternates": [
        {
          "model": "openai-codex/gpt-6.1-sol",
          "thinking": "high",
          "compactAt": 200000,
          "useFor": ["investigation", "root-causing bugs", "reviewing a builder's output"],
          "avoidFor": ["front-end design", "long unattended builds"]
        }
      ]
    }
  }
}
```

Use `opus` or `sol` in launch and policy models; roster aliases can override these built-ins or add names. Thinking suffixes such as `opus:high` are supported. Aliases resolve before alternate settings are selected. Sonnet is refused, including aliases that point to it, except front-desk's `claude-bridge/claude-sonnet-5-5` (Joel, 2026-10-04: "front desk needs to be opus 5 5 and sonnet 5 5"); exceptions live in `MODEL_EXCEPTIONS` in `src/models.ts`. Workers in any project may also opt into `claude-bridge/claude-sonnet-5-5` (Joel, 2026-10-05: "we can offer exploratry use of sonnet 55 for workers"), but only as an explicit launch `model`; a policy or roster default naming it is still refused (`ROLE_MODEL_EXCEPTIONS`). Fable is off fleet-wide (Joel, 2026-10-04) and refused everywhere; the judge defaults to Opus. `project_update` returns the aliases with the effective policy.

Every launch, fork, and restore runs `pi --list-models` once in the launch cwd, with a 20-second timeout, before writing a row or opening a pane. A missing authenticated model fails with working-route suggestions. A failed or empty listing permits launch with a `model check skipped` note.

Delivery requires Herdr `working`, two clean pane reads three seconds apart, and a newly appended matching user entry followed by a clean first assistant entry in the session journal (90 s bound); a missing or failed first turn returns `unproven` with a `FIRST_TURN` event and repair call. Long or multiline prompts use private durable file pointers, including on remote hosts; receipts include the pane's Pi path and version, or `unknown` if the probe fails. Only Pi-rendered `Error:` lines in the newest output above its editor count; prose, older errors, editor text, and footer text do not. Auth/model errors fail the launch and row, record the line in row events, and leave the pane open. Rate limits under the same prefix warn without failing. `project_status` checks only running, silent, nudged, and restarted rows whose Herdr status is not working. With `act: true`, it fails owned rows with a current model error. Finished rows keep their state. Model-failed rows require an explicit restore, not automatic adoption.

Role and alternate `skills` name standing skills (names or absolute paths); launch skills append after project policy skills, de-duplicated. Desk, boss, hawk and judge launches also load the package's `skills/muster`, unless `noSkills` is set. Workers keep `-ns` and search the installed catalog with `skill_find`, then read a matching `SKILL.md`.

## Tools

Owner side: `project_open`, `project_move`, `project_update`, `lane_open`, `lane_deliver`, `lane_close`, `agent_launch`, `agent_close`, `packet_verify`, `packet_land`, `desk_post`, `project_status`, `project_review`, `desk_inbox`, `desk_answer`, `desk_report`, `desk_rulings`, `thinking_set` (a session lowers or raises its own thinking level, as a standing Hawk does when the line stops).

### Deploy posture

VISION.md is canonical. Add a section like this; Muster prints this conservative template when it is missing and never edits the file:

```markdown
## Deploy posture
Level: 1 (prove)
Live proof frees the slot.
```

`project_update policy.deployLevel` is the fallback. No section or policy means level 1. A malformed section is reported and falls back. VISION wins over policy; status names a mismatch and shows each lane's effective level. Reads happen at call time.

| Level | Name | Deploy permission | WIP frees |
| --- | --- | --- | --- |
| 0 | locked | Cite a resolved approval desk item in evidence | Live proof |
| 1 | prove | Green gate | Live proof |
| 2 | ship-and-watch | Green gate, `Rollback: ...` and `Watch: ...` evidence lines | Deploy; proof checked at retro |
| 3 | jfdi | Green gate and `Rollback: ...` evidence line | Deploy; no proof step |

`lane_open deployLevel` only lowers permission and requires `deployRule`: `customer-facing`, `money`, `outbound-sends`, `irreversible`, `shared-infra` or `slow-rollback`. The tool refuses an override above that rule's cap. Customer-facing work, money or outbound sends cap permission at 1; irreversible work at 0; shared infrastructure at 2; rollback over five minutes or needing another person at 1. A later project-level decrease also lowers existing lanes.

`project_update` sets the sidebar headline and the project's policy: WIP and flow limits, silence limits and per-role model, thinking, compaction, and skills, merged over Muster's defaults.

## Delivery and flow

A lane is done when its work is live and proven, not merely merged. See [the definition of done and brief template](skills/muster/references/done.md). `packet_report` accepts `deploy`, `proof`, and `signals: { working, failing, where }` and includes them in its `.svx` report.

Committed `packet_land` outcomes start delivery at `landed`, with a timestamp. `lane_deliver({ slug, stage: "deployed" | "proven" | "waived", evidence })` records the next stage and its plain-word evidence. Proof may follow a waiver or deploy at any level. Delivery otherwise only moves forward within a cycle; another committed packet starts a new cycle. Docs or probes with nothing to deploy can be waived. Rejected and `no_changes` packets need no delivery. Old catalogs decode committed lanes as `proven` with evidence `before done-live`; new landed work is never backfilled.

Feature WIP includes open and draining work lanes, plus closed lanes still at `landed` or `deployed`, even if archived. At deploy levels 2 and 3, deployed lanes leave WIP even with an open tab; the flow line keeps them visible as `watching`. Role tabs and proposed (`open: false`) ideas do not count. `policy.wipLimit` defaults to 3; `null` disables it. At the limit, `lane_open` refuses and lists in-flight lanes with stage and age. Park ideas with `open: false`, or pass `override` containing Joel's words; the lane records them.

The board header and turn feeds show one flow line: `WIP 2/3 · landed, not live: lexicon-pin 40m · oldest in flight 2h · last proven 35m ago`. `⚠ not flowing` marks WIP with no recent proof or stage movement for `policy.flowStallMin` (default 120), or a reported packet waiting longer than `policy.landWaitMin` (default 30). These limits are minutes and can be changed with `project_update`. No extra sounds or toasts.

Worker side, when `MUSTER_AGENT` is set: `owner_note`, `owner_reply`, `owner_inbox`, `packet_report` and per-role compaction (`--compact-at`, `/compact-at`). A worker (`MUSTER_ROLE=worker`) gets its own queue tools but no project-management or operator tools.

`muster-heavy -- <command>` runs a command in the same machine-wide heavy slots as `packet_land` gates. `MUSTER_HEAVY_SLOTS` overrides the count; otherwise it is `max(1, floor(performanceCores / 3))` (4 on a 12-performance-core Mac). One reserved `deploy-0` slot sits on top of that count, so status shows `4 + 1 deploy`. Ordinary gates never use it. macOS reads `hw.perflevel0.physicalcpu`; the fallback uses half of `os.availableParallelism()` as performance cores.

Local heavy waiters use FIFO tickets in `~/.local/state/muster/heavy-queue/`, created with `wx` on the first failed attempt when `--wait` is positive. Tickets record pid, host, process start, enqueue time, truncated command, cwd and mode. Deploy-window tickets sort ahead of desk-granted tickets, which sort ahead of ordinary tickets; each tier keeps FIFO by padded millisecond timestamp then pid. A slot caller may enter only when fewer older live tickets exist than free slots; no-ticket callers, including local `packet_land` gates, count as newest. Queue decisions and slot acquisition share a short-lived `heavy-admission.lock` to prevent simultaneous polls from stealing a place. Memory pressure and exclusive fences still win; priority windows bypass only load pressure. An exclusive waiter may reserve its drain only at the queue head; once reserved it retains drain priority. Acquisition, timeout and signal/exit cleanup remove the owned ticket. Admission reaps dead or reused tickets; unknown, malformed and foreign-host tickets fail closed. Status lists queue position, pid, health, wait age and command in text and JSON without reaping. Waiting messages show the caller's position and age. Eligible waiters poll every second (the head also polls every second when no slots are free); others poll every five seconds. Reload older CLI sessions before relying on priority and FIFO, since older versions do not read or prioritize tickets.

When fleet-compute is installed, `project_status` shows gate slots and queue age; busy gate admission reports per-host queue positions. Status failures omit the line and add a note.

When installed, `packet_land` uses `fleet-compute gate` (`MUSTER_FLEET_COMPUTE` selects an absolute script path; `MUSTER_FLEET_COMPUTE=off` falls back to local admission); the receipt, not the process exit, decides the result, records the host, and proves the committed tree.

Admission waits only when available memory is below `MUSTER_HEAVY_MIN_FREE_GB` (default 16); slots bound concurrency, and load is reported but never refuses a job. macOS counts free, inactive and speculative pages from `vm_stat`; Linux uses `MemAvailable`. `--wait <seconds>` retries every 5 seconds and prints the reason. Without a wait, the CLI exits 75 and `packet_land` returns `HeavyJobBusy`, naming occupied slots or the admission blocker.

For a short deploy, use `MUSTER_DEPLOY_WINDOW=deploy-2026-10-04 muster-heavy --wait 1200 -- <command>`. A valid window without `--exclusive` requests priority: its ticket jumps ordinary waiters, FIFO among priority requests. It takes the reserved `deploy-0` slot first, without draining or fencing normal slots. If that slot is unavailable without a known priority holder, it falls back to the next free normal slot ahead of ordinary waiters. Only one priority holder runs at a time across both kinds of slot; a second waits at the front even if normal slots are free. A deploy never waits on gates. It can still wait on another deploy, an exclusive drain or hold, or memory pressure. Unknown reserved-slot holders fail closed; if no normal slot is free, they also block a deploy. Priority never bypasses the free-memory floor or invalid machine samples. Its hold has a hard five-minute cap from acquisition; `MUSTER_DEPLOY_CAP_MIN` can only lower it, clamped to 1–5 minutes. Invalid windows exit 64 and log `refused`. Unset the window for ordinary gates. Library callers use `priorityRequest` with an explicit `window`; `tryAcquireHeavy` stays ordinary even when given a window. Status marks priority tickets and holders `⚡ window <id>`, with wait/hold age and the holder's remaining cap. The reserved slot shows `deploy-0: free` or `deploy-0: ⚡ window <id> … left Ns`; JSON exposes it as `deploySlot`.

For a few named critical-path gates, the desk issues `muster-heavy grant <label> --ttl 1h`. It prints a random 16-hex-character grant id. Workers use `MUSTER_HEAVY_GRANT=<id> muster-heavy --wait 1200 -- <command>` with the deploy window unset. Workers must not grant themselves. `muster-heavy grant --list` lists live grants and reaps expired ones; `muster-heavy grant --revoke <id>` revokes one. The default TTL is one hour; durations use `ms`, `s`, `m` or `h` and clamp to two hours. A machine can have at most four live grants. A fifth exits 64 and lists the live grants. Grant operations share the admission lock so concurrent issuers cannot exceed the limit.

A grant reorders the queue; it does not add capacity. Shedding load is still the fix for saturation. Grant jobs run behind deploy-window waiters and ahead of ordinary waiters, FIFO within their tier. They use only normal slots, never `deploy-0`, and obey the normal load and memory limits. They have no hold cap. The grant must remain live until admission; an admitted job keeps running after expiry or revocation. Unknown or expired ids exit 64 rather than falling back to ordinary admission. Do not combine a grant with a deploy window or `--exclusive`.

Grants are self-issued on a single-user machine, not authenticated desk permissions. The desk owns granting; the four-grant machine limit, TTL and audit enforce the bounds. Grant records live in `~/.local/state/muster/heavy-grants/<id>.json` with the label, issuer (`MUSTER_AGENT`, `PI_SESSION_ID` or `cli`), cwd and creation/expiry timestamps. Admission and listing reap expired records. Grant creation, revocation, request, acquisition, release and refusal append to `heavy-exclusive.jsonl` with `mode: "grant"`, label and `grantedBy` (null when the id is unknown). Acquisitions also record the normal slot name. Status shows `🎟️ grant <label>` on holders and waiters, plus `grants: N/4 live`; JSON exposes `grants` and grant metadata on holders/tickets. Plain status stays read-only. Reload old CLI sessions before relying on grant queue order.

The window is self-declared: any agent can set it on this single-user machine. It is not an unforgeable capability. Every use is audited, and the short cap kills a long test gate that borrows deploy priority. Audit and the cap make abuse visible and unhelpful, not impossible.

When a deploy must drain and hold every slot, use `MUSTER_DEPLOY_WINDOW=deploy-2026-10-04 muster-heavy --exclusive --wait 1200 -- <command>`. Missing or invalid windows refuse with exit 64, without taking a lock or falling back to slots. The id must be 1–64 characters from `[A-Za-z0-9._:-]`. Library callers must pass `window` explicitly to `exclusiveRequest`; ambient environment authorization is not enough. Ordinary tests and commit hooks use slots, not `--exclusive`. An exclusive waiter checks load and memory before reserving admission. Once reserved, it keeps drain priority, holds all configured and existing slots (including the legacy lock and `deploy-0`), and releases on command exit. Timeout or cancellation clears only its own reservations. `muster-heavy status` (or `status --json`, the same fields for tools) shows the count, load, available memory, every slot and the exclusive-pending holder, age, and health (`alive`, `dead`, `reused`, or `unknown`) without changing locks. Exclusive entries also show the window, hold age and seconds remaining to the cap; a pending request has no hold age until drained. Free entries have null health and age. Waiting messages also show holder health and age. Admission reclaims dead local holders and reused pids whose process start is later than the recorded holder timestamp; `.local` and `.localdomain` hostname variants count as the same machine. Missing process-start evidence never proves reuse; unknown or foreign-host holders fail closed.

Exclusive holds have a hard 20-minute cap from acquisition, not request time. `MUSTER_EXCLUSIVE_CAP_MIN` can only lower it, clamped to 1–20 minutes. Both priority and exclusive windows use the same cap machinery. At the cap the CLI sends SIGTERM to the detached child process group, waits 15 seconds, then sends SIGKILL, releases its locks and exits 124. Requests, acquisitions, releases, refusals, caps and reaps append private JSONL audit records to `~/.local/state/muster/heavy-exclusive.jsonl` with `mode: "priority"` or `mode: "exclusive"` and caller fields; priority acquisitions also record `slot` (`deploy-0` or `slot-<n>`); cap and reap events also print to stderr. Admission and explicit `status --reap` reclaim priority and exclusive holds older than their cap plus two minutes. A same-host live holder receives SIGTERM and immediate SIGKILL before its locks are removed; unknown and foreign-host holders fail closed. The reaper also frees dead or reused local `deploy-0` holders before their cap. Plain `status` and `status --json` remain read-only. Legacy exclusive holders without an acquisition timestamp use their recorded start time for the backstop.

Slot 0 retains `heavy-job.lock`; other normal slots use `heavy-job.lock.<n>`. The reserved slot uses `heavy-job.lock.deploy-0`. Reload old CLI sessions before relying on reserved capacity: older exclusive holders do not drain or hold this path. Ordinary slot holders carry `mode: "slot"`; priority slot holders carry `mode: "priority"` and reuse the window hold-clock fields; an exclusive hold marks slot 0 `mode: "exclusive"`. Only that marker fences new admission. A live unmarked holder from older code counts as one busy slot and is never deleted. Older single-lock sessions see exclusive holds as busy. Sessions on the intermediate multi-slot hotfix do not understand exclusive-pending; reload them before relying on deploy admission fencing, and keep slot counts consistent across sessions.

## Owner queues

Owner messages and inbox results share a styled timeline: mention cards first, quiet posts grouped by agent, with expandable threads and refs and a plain `NO_COLOR` view.

Workers and bosses use `owner_note({kind, title, body?, refs?, replyTo?})`. FYI, progress and done accumulate silently. Questions, blocked notices and packet actions automatically mention the owner resolved at send time. `owner_note` reads the `MUSTER_PROJECT` catalog row named by `MUSTER_AGENT`; if the catalog is unreadable or the row is absent, its receipt names the `MUSTER_OWNER` fallback. Takeover and restored or relaunched rows leave an owner-queue forward. New senders follow up to four hops and rewrite owner mentions; cycles and longer routes fail closed. The new owner's feed also tails old queues, so workers still on old code need no restart. Forwarded records appear in `owner_inbox` with `via <old owner short id>`. Each source keeps a branch cursor across reloads. History at takeover is included only after the old reader's last heartbeat, or entirely when no reader file exists. `owner_reply` still targets the parent's author.

Only a mention wakes a reader, and only when idle; busy arrivals ride on the next turn. One digest groups unread posts by author, keeps the latest progress, and includes all FYI/done titles.

`owner_inbox({since?, kinds?, limit?, ack?})` reads this session's queue. Without `since`, it returns undelivered posts; `since` includes recent delivered posts. `ack` consumes only returned items. `owner_reply({uri, text})` replies to a post in this session's queue, threads its root and parent, and mentions the author in their queue. Workers run the reader too.

Storage is private local JSONL at `~/.local/state/muster/owner-queue/<session>.jsonl`, separate from Joel's desk queue. Lines use `dev.muster.note.post` records with local `muster://` URIs, time-sortable keys, truncated canonical-JSON SHA-256 cids, session authors and UTF-8 mention facets. Titles cap at 200 characters, bodies at 4096 bytes. NSIDs and the local lexicon live in `src/owner-lexicon.ts` and `.json`. This is not a PDS: follows, a public timeline and real atproto transport are deferred.

A watch plus a 30-second poll delivers mentions. Session custom entries persist the cursor and delivered URIs across reload. A reader presence heartbeat expires after two minutes; a missing, stale or dead reader, queue failure or telemetry failure uses intercom for waking posts, while retaining the queued copy when possible. Tool results identify the path. Relay counters record metadata only, never titles or bodies.

## Switchboard

One inbox over every project's desk queue. It reads and routes; project desks stay the authority for their own work. Start a session as the Switchboard with `pi --switchboard` (or `MUSTER_SWITCHBOARD=1`, or `/switchboard on`). Nothing starts on its own otherwise.

- The collapsed widget is a theme-colored flame graph, at most eight lines: four to six flame rows, project labels (`☠` means a dead desk), and one open-count summary. Blocked/approval/decision weights are 3/2/1; logarithmic age adds height and heat. Quiet projects show dim embers and yield space first. Below 40 columns, with `NO_COLOR`, `TERM=dumb`, or an uncolored theme, it shows only the plain summary.
- Flames flicker deterministically at about 7 fps, flare for 1.5 seconds on arrivals, and settle for 2 seconds on resolutions. Only the active visible Switchboard animates; the overlay pauses it. After 60 seconds without queue changes or input it freezes, resuming on either. Pi-tui 0.84.3 exposes no terminal-focus notification API; incoming CSI focus reports are honored if the host supplies them. Animation only invalidates the widget and requests a TUI render, never a model turn.
- The expanded `alt+s` overlay keeps the ranked `project#id` asks and ticker in its header, above the navigable project rows. It keeps the newest five queue events for an hour; resolutions show `✓ resolved`. On short terminals the header yields room to navigation.
- Queue changes repaint without a model turn, with a one-second timer as the watch backstop. Queue reads retain byte offsets and reset on truncation or replacement; ages tick from cached records. Fleet topology and desk liveness refresh every 30 seconds or on registry changes. `☠ no live desk` means no catalog desk or owner is in the live intercom session list; an unavailable session list shows no marker. The first refresh failure is logged with its message.
- Nudges are only a courtesy: writes before Switchboard registration, old extension versions, and external queue writers can miss them. Activation and filesystem reads show the entire open queue anyway.
- `alt+s` or `/switchboard` browses everything: `j`/`k` move, `space` folds, `enter` puts an `[project#id]` reference in the editor, `a` answers, `d` marks done.
- `desk_inbox` lists open items ranked blocked, approval, decision, oldest first. It is read-only; only `subscribe: true`, `--switchboard`, or `/switchboard` makes a session the Switchboard that is paged on every queue change, and never one Muster launched (any `MUSTER_ROLE`). `desk_answer` appends a resolving line to the item's own queue and nudges that project's desk.

## Relay diet

Packet reports still send one actionable intercom message to the owner. The owner must verify and land them.

The Muster desk feed suppresses ids created by this session's `desk_post`, `desk_answer`, and `desk_rulings` tools. It reserves the queue id before writing, keeps it in memory, and saves a `muster-desk-self-post` custom session entry for reload. A failed attempt may leave an unused reserved id. Other sessions' items still arrive, even when their sender label matches. The queue and inbox remain unchanged; only self-delivery is suppressed.

With Bellwether's pane-close bus support, `agent_close` and `lane_close` notify Bellwether before closing a pane Muster opened. The `bellwether/pane-close/v1` event carries the pane id, recorded terminal id, reason and synchronous reply callback. Bellwether retires the owner's matching watches and withdraws their held wakes; close receipts report `watches retired: <ids>` (or `none`). Owners no longer need to cancel their own blocked-watch manually. With older Bellwether or no listener, list the pane's watches and cancel them first with `herdr_watch action=cancel id=<id>`. Fallback receipts name candidate ids from session receipts, not confirmed live watches; named agent targets need inspection too.

`~/.local/state/muster/relay-events.jsonl` holds best-effort metadata counters, one line per packet relay attempt or queue item delivered/skipped. Each line contains `{ts, session, kind, project, packetId?, itemId?}`; no bodies, titles or refs. `kind` is `packet_report`, `desk_note`, `desk_note_skipped_self`, or `watch_retired`. A synchronous pane-close acknowledgement emits one `watch_retired` line per retired id, stored in `itemId`; the fallback emits none. A batch delivered before a user turn records one `desk_note` per item, not one per card. These counts measure relay boundaries, not completed model turns. Write failures never fail a tool or feed delivery.

## Desk report

When a desk holds several decisions, it publishes one static feedback page instead of a chat digest. `desk_report` builds it from report items: one card per decision, radio sets per decision axis, and a copy-feedback button. The page is noindex and holds no links or addresses. `desk_rulings` turns the pasted feedback into one resolving line per desk item, plus one message for the owner. The contract is in [skills/muster/references/desk-report.md](skills/muster/references/desk-report.md). The page inlines ratstack's `app.css` when it is on the machine (`MUSTER_DESK_REPORT_CSS` overrides the path).

## State

- `<project>/.brain/data/muster/project.json`: the project, its lanes, agent rows, and packets. Schema-decoded on every read; written with a lock and an atomic rename.
- `<project>/.brain/data/muster/reports/`: packet reports as `.svx`, with title, packet id and lane frontmatter. Worker text is fenced as code for MDsveX; existing `.md` report paths still verify and land without migration. `closed/`: pane tails saved before a close or restart.
- `<project>/.brain/projects/muster/<slug>.svx`: a generated Brain board.
- `~/.local/state/herdr-desk/<slug>.jsonl`: the desk queue, one JSON line per item.
- `~/.local/state/muster/heavy-job.lock` (slot 0), `heavy-job.lock.<n>` (normal slots), `heavy-job.lock.deploy-0` (reserved deploy slot): atomic mkdir heavy slots with `holder.json`.
- `~/.local/state/muster/heavy-grants/<id>.json`: desk-issued queue grants, at most four live, each with a TTL of at most two hours.
- `~/.local/state/muster/heavy-queue/`: FIFO waiter tickets; `heavy-admission.lock` serializes local admission decisions.
- `~/.local/state/muster/heavy-job.lock.exclusive-pending`: the exclusive request's holder and admission fence.
- `~/.local/state/muster/projects.jsonl`: every project `project_open` has seen, so the Switchboard can find them all.

Muster refuses project state, briefs, and agent cwds under a temp dir unless the project was opened with `ephemeral: true`.

## Lifecycles

XState machines, persisted as the state value on each row:

- Agent: `planned → launching → running → reported → verified → landed → closed`; `running → silent → nudged → restarted`; `* → interrupted → restoring → running`; `failed`.
- Lane: `proposed → open → draining → closed`.
- Lane delivery: `none → landed → deployed → proven`; `landed → proven` permits a combined live deploy check; `none | landed | deployed → waived` records nothing to deploy.
- Project: `setup → active → reviewing → active | archived`.

An illegal transition is a typed `IllegalTransition` error. Sidebar tokens (`now`, `progress`, `agents`, `needs`, source `user:muster.v1`) are derived from these states, the headline, and the desk queue. In a space it owns, Muster keeps the space label a plain name.

## Checks

```bash
npm install --ignore-scripts
npm run check
npm test
npm run smoke
npm run pack:check
```

## License

MIT
