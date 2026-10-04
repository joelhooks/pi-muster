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

Muster records the package commit when the extension loads, without spawning Git. Every tool, including desk and Switchboard tools, checks for changes at most once per minute. A changed commit adds a stale-tools warning with both short SHAs and the commit count when Git can calculate it. `project_status` also marks its board header. Restart the session or use `/reload` to load the new tools; Claude bridge sessions need a restart.

Outside a Git checkout, the check uses the package version and newest mtime of the extension's local source imports. Missing metadata or a failed check never blocks a tool. Startup reads version metadata only; it opens no socket or bus channel.

## Roster

Role models are data. Muster reads `~/.config/muster/roster.json` (or `MUSTER_ROSTER`) on every call, so one edited and synced file changes what every machine launches next. Without it, built-in defaults apply. Precedence: built-in, roster role, the alternate matching the chosen model, project policy, explicit `agent_launch` arguments.

```json
{
  "version": 1,
  "aliases": {
    "opus": "claude-bridge/claude-opus-5-5",
    "fable": "claude-bridge/claude-fable-5-1",
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

Use `opus`, `fable`, or `sol` in launch and policy models; roster aliases can override these built-ins or add names. Thinking suffixes such as `opus:high` are supported. Aliases resolve before alternate settings are selected. Sonnet is refused, including aliases that point to it. `project_update` returns the aliases with the effective policy.

Every launch, fork, and restore runs `pi --list-models` once in the launch cwd, with a 20-second timeout, before writing a row or opening a pane. A missing authenticated model fails with working-route suggestions. A failed or empty listing permits launch with a `model check skipped` note.

Delivery requires Herdr `working` and two clean pane reads, three seconds apart. Only Pi-rendered `Error:` lines in the newest output above its editor count; prose, older errors, editor text, and footer text do not. Auth/model errors fail the launch and row, record the line in row events, and leave the pane open. Rate limits under the same prefix warn without failing. `project_status` checks only running, silent, nudged, and restarted rows whose Herdr status is not working. With `act: true`, it fails owned rows with a current model error. Finished rows keep their state. Model-failed rows require an explicit restore, not automatic adoption.

Role and alternate `skills` name standing skills (names or absolute paths); launch skills append after project policy skills, de-duplicated. Workers keep `-ns` and search the installed catalog with `skill_find`, then read a matching `SKILL.md`.

## Tools

Owner side: `project_open`, `project_move`, `project_update`, `lane_open`, `lane_close`, `agent_launch`, `agent_close`, `packet_verify`, `packet_land`, `desk_post`, `project_status`, `project_review`, `desk_inbox`, `desk_answer`, `desk_report`, `desk_rulings`, `thinking_set` (a session lowers or raises its own thinking level, as a standing Hawk does when the line stops).

`project_update` sets the sidebar headline and the project's policy: silence limits and per-role model, thinking, compaction, and skills, merged over Muster's defaults.

Worker side, when `MUSTER_AGENT` is set: `packet_report` and per-role compaction (`--compact-at`, `/compact-at`). A worker (`MUSTER_ROLE=worker`) gets no owner tools and no path to the operator.

`muster-heavy -- <command>` runs a command in the same machine-wide heavy slots as `packet_land` gates. `MUSTER_HEAVY_SLOTS` overrides the count; otherwise it is `max(1, floor(performanceCores / 3))` (4 on a 12-performance-core Mac). macOS reads `hw.perflevel0.physicalcpu`; the fallback uses half of `os.availableParallelism()` as performance cores.

Local heavy waiters use FIFO tickets in `~/.local/state/muster/heavy-queue/`, created with `wx` on the first failed attempt when `--wait` is positive. Tickets record pid, host, process start, enqueue time, truncated command, cwd and mode. Arrival names sort by padded millisecond timestamp then pid. A slot caller may enter only when fewer older live tickets exist than free slots; no-ticket callers, including local `packet_land` gates, count as newest. Queue decisions and slot acquisition share a short-lived `heavy-admission.lock` to prevent simultaneous polls from stealing a place. Pressure and exclusive fences still win. An exclusive waiter may reserve its drain only at the queue head; once reserved it retains drain priority. Acquisition, timeout and signal/exit cleanup remove the owned ticket. Admission reaps dead or reused tickets; unknown, malformed and foreign-host tickets fail closed. Status lists queue position, pid, health, wait age and command in text and JSON without reaping. Waiting messages show the caller's position and age. Eligible waiters poll every second (the head also polls every second when no slots are free); others poll every five seconds. Reload older CLI sessions before relying on FIFO, since they do not read tickets.

When fleet-compute is installed, `project_status` shows gate slots and queue age; busy gate admission reports per-host queue positions. Status failures omit the line and add a note.

When installed, `packet_land` uses `fleet-compute gate` (`MUSTER_FLEET_COMPUTE` selects an absolute script path; `MUSTER_FLEET_COMPUTE=off` falls back to local admission); the receipt, not the process exit, decides the result, records the host, and proves the committed tree.

Admission waits when 1-minute load exceeds available cores × 2.5 or available memory is below `MUSTER_HEAVY_MIN_FREE_GB` (default 16). macOS counts free, inactive and speculative pages from `vm_stat`; Linux uses `MemAvailable`. `--wait <seconds>` retries every 5 seconds and prints the reason. Without a wait, the CLI exits 75 and `packet_land` returns `HeavyJobBusy`, naming occupied slots or the admission blocker.

For a deploy window, use `MUSTER_DEPLOY_WINDOW=deploy-2026-10-04 muster-heavy --exclusive --wait 1200 -- <command>`. Missing or invalid windows refuse with exit 64, without taking a lock or falling back to slots. The id must be 1–64 characters from `[A-Za-z0-9._:-]`. Library callers must pass `window` explicitly to `exclusiveRequest`; ambient environment authorization is not enough. Ordinary tests and commit hooks use slots, not `--exclusive`. An exclusive waiter checks load and memory before reserving admission. Once reserved, it keeps drain priority, holds all configured and existing slots (including the legacy lock), and releases on command exit. Timeout or cancellation clears only its own reservations. `muster-heavy status` (or `status --json`, the same fields for tools) shows the count, load, available memory, every slot and the exclusive-pending holder, age, and health (`alive`, `dead`, `reused`, or `unknown`) without changing locks. Exclusive entries also show the window, hold age and seconds remaining to the cap; a pending request has no hold age until drained. Free entries have null health and age. Waiting messages also show holder health and age. Admission reclaims dead local holders and reused pids whose process start is later than the recorded holder timestamp; `.local` and `.localdomain` hostname variants count as the same machine. Missing process-start evidence never proves reuse; unknown or foreign-host holders fail closed.

Exclusive holds have a hard 20-minute cap from acquisition, not request time. `MUSTER_EXCLUSIVE_CAP_MIN` can only lower it, clamped to 1–20 minutes. At the cap the CLI sends SIGTERM to the detached child process group, waits 15 seconds, then sends SIGKILL, releases its locks and exits 124. Requests, acquisitions, releases, refusals, caps and reaps append private JSONL audit records to `~/.local/state/muster/heavy-exclusive.jsonl`; cap and reap events also print to stderr. Admission and explicit `status --reap` reclaim exclusive holds older than their cap plus two minutes. A same-host live holder receives SIGTERM and immediate SIGKILL before its locks are removed; unknown and foreign-host holders fail closed. Plain `status` and `status --json` remain read-only. Legacy exclusive holders without an acquisition timestamp use their recorded start time for the backstop.

Slot 0 retains `heavy-job.lock`; other slots use `heavy-job.lock.<n>`. Slot holders carry `mode: "slot"`; an exclusive hold marks slot 0 `mode: "exclusive"`. Only that marker fences new admission. A live unmarked holder from older code counts as one busy slot and is never deleted. Older single-lock sessions see exclusive holds as busy. Sessions on the intermediate multi-slot hotfix do not understand exclusive-pending; reload them before relying on deploy admission fencing, and keep slot counts consistent across sessions.

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

Before `agent_close` or `lane_close`, list the pane's Bellwether watches and cancel them with `herdr_watch action=cancel id=<id>`. Bellwether's live registry and wake router are private to its extension; Muster cannot cancel a watch or withdraw a held wake through its library exports. Close receipts name candidate watch ids when session receipts identify running watches on the pane. These are hints, not proof of a live watch; named agent targets need inspection too. No automatic retirement is claimed.

`~/.local/state/muster/relay-events.jsonl` holds best-effort metadata counters, one line per packet relay attempt or queue item delivered/skipped. Each line contains `{ts, session, kind, project, packetId?, itemId?}`; no bodies, titles or refs. `kind` is `packet_report`, `desk_note`, `desk_note_skipped_self`, or `watch_retired`. The latter is reserved for supported automatic retirement and is not emitted by the current fallback. A batch delivered before a user turn records one `desk_note` per item, not one per card. These counts measure relay boundaries, not completed model turns. Write failures never fail a tool or feed delivery.

## Desk report

When a desk holds several decisions, it publishes one static feedback page instead of a chat digest. `desk_report` builds it from report items: one card per decision, radio sets per decision axis, and a copy-feedback button. The page is noindex and holds no links or addresses. `desk_rulings` turns the pasted feedback into one resolving line per desk item, plus one message for the owner. The contract is in [skills/muster/references/desk-report.md](skills/muster/references/desk-report.md). The page inlines ratstack's `app.css` when it is on the machine (`MUSTER_DESK_REPORT_CSS` overrides the path).

## State

- `<project>/.brain/data/muster/project.json`: the project, its lanes, agent rows, and packets. Schema-decoded on every read; written with a lock and an atomic rename.
- `<project>/.brain/data/muster/reports/`: packet reports as `.svx`, with title, packet id and lane frontmatter. Worker text is fenced as code for MDsveX; existing `.md` report paths still verify and land without migration. `closed/`: pane tails saved before a close or restart.
- `<project>/.brain/projects/muster/<slug>.svx`: a generated Brain board.
- `~/.local/state/herdr-desk/<slug>.jsonl`: the desk queue, one JSON line per item.
- `~/.local/state/muster/heavy-job.lock` (slot 0), `heavy-job.lock.<n>`: atomic mkdir heavy slots with `holder.json`.
- `~/.local/state/muster/heavy-queue/`: FIFO waiter tickets; `heavy-admission.lock` serializes local admission decisions.
- `~/.local/state/muster/heavy-job.lock.exclusive-pending`: the exclusive request's holder and admission fence.
- `~/.local/state/muster/projects.jsonl`: every project `project_open` has seen, so the Switchboard can find them all.

Muster refuses project state, briefs, and agent cwds under a temp dir unless the project was opened with `ephemeral: true`.

## Lifecycles

XState machines, persisted as the state value on each row:

- Agent: `planned → launching → running → reported → verified → landed → closed`; `running → silent → nudged → restarted`; `* → interrupted → restoring → running`; `failed`.
- Lane: `proposed → open → draining → closed`.
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
