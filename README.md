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

`muster-heavy -- <command>` registers a job and runs it immediately. It never queues, grants capacity, checks memory for admission, or holds an exclusive window. Local `packet_land` gates run through the same CLI. Old admission flags and environment settings are accepted and ignored, with one stderr line naming them. Old `grant` management commands are inert.

Jobs live in `~/.local/state/muster/jobs/<id>.json`: id, host, repo, cwd, full command, wrapper pid and start time. The wrapper is the process-tree root. A shared cache batches one `ps` across live jobs every five seconds. Status shows tree CPU percentage, current RSS and sampled peak RSS in KB. On exit the record has exit code, wall milliseconds, CPU-seconds and peak RSS. `/usr/bin/time` supplies final CPU accounting even for commands shorter than the sample interval. Darwin uses portable output; GNU/Linux includes the child exit field to distinguish signals from intentional exits such as 143. RSS peaks are sampled, so short spikes between samples are not measured. A dead wrapper without an exit is marked `exit: null, lost: true` on the next status or report pass.

Use `muster-heavy status [--json]` for live jobs and `muster-heavy report [--since 24h] [--json]` for per-repo and per-command count, total wall time, total CPU-seconds and maximum RSS. The report selects jobs by start time and includes lost-job counts. State and telemetry files stay private.

The status JSON keeps fleet-compute's placement fields. `holders` has one held entry per live job with `mode: "job"` and the full command, including any `fc-<runId>` marker. `slots` is live jobs plus one, not a capacity limit; `minFreeGB` reports `MUSTER_HEAVY_MIN_FREE_GB` (default 16 GB), which fleet-compute may use for placement. Local execution never consults that floor. `availableGB` counts free, inactive and speculative pages on macOS, and `MemAvailable` on Linux, rather than raw free memory. `loadLimit` is a large constant and `exclusivePending` is not held. `jobs` adds telemetry.

`muster-heavy gate --wait 1200 -- <command>` is unchanged: fleet-compute owns placement and queueing. `--wait` still applies to fleet routing, not local execution. `MUSTER_FLEET_COMPUTE` selects an absolute runner script; `off` or a missing runner falls back to immediate local execution. Installed `packet_land` uses fleet receipts to decide success and prove the committed tree. Keep `pack:check` and `smoke` local.

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
- `~/.local/state/muster/jobs/<id>.json`: private atomic job records, retained after exit.
- `~/.local/state/muster/jobs/samples.json`: shared five-second process telemetry cache; `sampling/` serializes cache writes only, never command execution. Legacy admission files are unused and left untouched.
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
