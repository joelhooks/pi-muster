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

## Tools

Owner side: `project_open`, `project_update`, `lane_open`, `lane_close`, `agent_launch`, `agent_close`, `packet_verify`, `packet_land`, `desk_post`, `project_status`, `project_review`.

`project_update` sets the sidebar headline and the project's policy: silence limits and per-role model, thinking, compaction, and skills, merged over Muster's defaults.

Worker side, when `MUSTER_AGENT` is set: `packet_report` and per-role compaction (`--compact-at`, `/compact-at`). A worker (`MUSTER_ROLE=worker`) gets no owner tools and no path to the operator.

`muster-heavy -- <command>` runs a command under the machine-wide heavy-job lock that `packet_land` gates also take.

## State

- `<project>/.brain/data/muster/project.json`: the project, its lanes, agent rows, and packets. Schema-decoded on every read; written with a lock and an atomic rename.
- `<project>/.brain/data/muster/reports/`: packet reports. `closed/`: pane tails saved before a close or restart.
- `<project>/.brain/projects/muster/<slug>.svx`: a generated Brain board.
- `~/.local/state/herdr-desk/<slug>.jsonl`: the desk queue, one JSON line per item.
- `~/.local/state/muster/heavy-job.lock`: the heavy-job lock.

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
