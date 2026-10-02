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

## Roster

Role models are data. Muster reads `~/.config/muster/roster.json` (or `MUSTER_ROSTER`) on every call, so one edited and synced file changes what every machine launches next. Without it, built-in defaults apply. Precedence: built-in, roster role, the alternate matching the chosen model, project policy, explicit `agent_launch` arguments.

```json
{
  "version": 1,
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

## Tools

Owner side: `project_open`, `project_move`, `project_update`, `lane_open`, `lane_close`, `agent_launch`, `agent_close`, `packet_verify`, `packet_land`, `desk_post`, `project_status`, `project_review`, `desk_inbox`, `desk_answer`, `desk_report`, `desk_rulings`, `thinking_set` (a session lowers or raises its own thinking level, as a standing Hawk does when the line stops).

`project_update` sets the sidebar headline and the project's policy: silence limits and per-role model, thinking, compaction, and skills, merged over Muster's defaults.

Worker side, when `MUSTER_AGENT` is set: `packet_report` and per-role compaction (`--compact-at`, `/compact-at`). A worker (`MUSTER_ROLE=worker`) gets no owner tools and no path to the operator.

`muster-heavy -- <command>` runs a command in the same machine-wide heavy slots as `packet_land` gates. `MUSTER_HEAVY_SLOTS` overrides the count; otherwise it is `max(1, floor(performanceCores / 3))` (4 on a 12-performance-core Mac). macOS reads `hw.perflevel0.physicalcpu`; the fallback uses half of `os.availableParallelism()` as performance cores.

Admission waits when 1-minute load exceeds available cores × 2.5 or available memory is below `MUSTER_HEAVY_MIN_FREE_GB` (default 16). macOS counts free, inactive and speculative pages from `vm_stat`; Linux uses `MemAvailable`. `--wait <seconds>` retries every 5 seconds and prints the reason. Without a wait, the CLI exits 75 and `packet_land` returns `HeavyJobBusy`, naming occupied slots or the admission blocker.

For a deploy window, use `muster-heavy --exclusive --wait 1200 -- <command>`. It reserves admission, drains all configured and existing slots, holds them all (including the legacy lock), and releases on command exit. Timeout or cancellation clears only its own reservations. `muster-heavy status` shows the count, load, available memory, every slot's holder and age, and the exclusive-pending marker without changing locks. Dead local holders are reclaimed only during acquisition; unknown or foreign-host holders fail closed.

Slot 0 retains `heavy-job.lock`; other slots use `heavy-job.lock.<n>`. New slot holders carry a `mode: "slot"` marker. A live, unmarked legacy lock is treated as exclusive until it drains, never deleted. Older single-lock sessions see exclusive holds as busy. Sessions on the intermediate multi-slot hotfix do not understand exclusive-pending; reload them before relying on deploy admission fencing, and keep slot counts consistent across sessions.

## Switchboard

One inbox over every project's desk queue. It reads and routes; project desks stay the authority for their own work. Start a session as the Switchboard with `pi --switchboard` (or `MUSTER_SWITCHBOARD=1`, or `/switchboard on`). Nothing starts on its own otherwise.

- The widget holds three rows at most: open asks by kind and age plus the Muster fleet (projects, lanes, running agents, packets to land), then the two most urgent desks with a 24-hour heat strip of queue traffic.
- `alt+s` or `/switchboard` browses everything: `j`/`k` move, `space` folds, `enter` puts an `[project#id]` reference in the editor, `a` answers, `d` marks done.
- `desk_inbox` lists open items ranked blocked, approval, decision, oldest first. It is read-only; only `subscribe: true`, `--switchboard`, or `/switchboard` makes a session the Switchboard that is paged on every queue change, and never one Muster launched (any `MUSTER_ROLE`). `desk_answer` appends a resolving line to the item's own queue and nudges that project's desk.

## Desk report

When a desk holds several decisions, it publishes one static feedback page instead of a chat digest. `desk_report` builds it from report items: one card per decision, radio sets per decision axis, and a copy-feedback button. The page is noindex and holds no links or addresses. `desk_rulings` turns the pasted feedback into one resolving line per desk item, plus one message for the owner. The contract is in [skills/muster/references/desk-report.md](skills/muster/references/desk-report.md). The page inlines ratstack's `app.css` when it is on the machine (`MUSTER_DESK_REPORT_CSS` overrides the path).

## State

- `<project>/.brain/data/muster/project.json`: the project, its lanes, agent rows, and packets. Schema-decoded on every read; written with a lock and an atomic rename.
- `<project>/.brain/data/muster/reports/`: packet reports as `.svx`, with title, packet id and lane frontmatter. Worker text is fenced as code for MDsveX; existing `.md` report paths still verify and land without migration. `closed/`: pane tails saved before a close or restart.
- `<project>/.brain/projects/muster/<slug>.svx`: a generated Brain board.
- `~/.local/state/herdr-desk/<slug>.jsonl`: the desk queue, one JSON line per item.
- `~/.local/state/muster/heavy-job.lock` (slot 0), `heavy-job.lock.<n>`: atomic mkdir heavy slots with `holder.json`.
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
