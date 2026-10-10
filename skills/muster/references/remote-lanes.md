# Remote lane workers

The desk, catalog and landing repository stay on the owner machine. A saved machine supplies worker panes, clones and sessions. Muster uses a private SSH Unix-socket forward to Bellwether's existing Herdr client. It does not change Herdr or start its server.

## Configure a machine

Create `~/.config/muster/machines.json` on the owner machine. Missing configuration means local only. The keys are the `machine` values accepted by `agent_launch`. This is an example, not an installed configuration:

```json
{
  "pennywise": {
    "herdr": "pennywise",
    "ssh": "pennywise",
    "socket": "/home/joel/.config/herdr/herdr.sock",
    "paths": {
      "/Users/joel/Code": "/home/joel/Code",
      "/Users/joel/.agent/projects": "/home/joel/.agent/projects"
    },
    "musterExtension": "/home/joel/Code/joelhooks/pi-muster",
    "workerWorktree": "/home/joel/Code/joelhooks/dark-wizard/scripts/worker-worktree.sh",
    "env": { "CUDA_VISIBLE_DEVICES": "" },
    "wrap": ["/usr/local/bin/pw-worker-scope", "--name", "{name}", "--"],
    "maxPanes": 3
  }
}
```

`paths` maps complete path prefixes, longest first. It does not copy files. Sync the source checkout, briefs, skills and extra extensions before launch. `wrap` belongs to the machine owner; Muster substitutes the row name for `{name}`. The wrapper must preserve the pane environment, including `HERDR_PANE_ID`, `MUSTER_*` and PATH, and return the worker's exit code. `maxPanes` counts registered projects' non-closed rows on the machine, including interrupted or failed rows.

## Prerequisites

- Key-based, noninteractive SSH from the owner to the configured target.
- A running Herdr server at the configured socket. On pennywise it must run as a user service with linger. The machine owner starts and maintains it, not Muster.
- `pi`, `node`, `git` and `rift` on the remote noninteractive PATH.
- A readable Muster package with installed dependencies at `musterExtension`.
- An executable `worker-worktree.sh` at `workerWorktree`, and its rift dependencies.
- The mapped source repository, briefs, skills and extensions on the remote filesystem.
- The owner's wrapper installed and executable, and the requested model authenticated in remote Pi.

Remote rows ride Rat King by name, like local ones. Under the legacy intercom policy, notes and packets reach the Flagg owner by SSH pull instead. Muster does not install a bridge.

Remote `launch`, `fork`, and `restore` jobs run in the same locally detached process as local launches. The immediate receipt names the job and local log. Read the full owner-queue action before arming a pane watch. Configuration errors fail admission immediately; transport and prerequisite failures arrive as a `blocked` owner item with the machine name. The forward's control master expires after ten idle minutes; live held sockets use the same forward. A machine-wide launch lock serializes capacity checks across projects. If a crashed launch leaves a lock, the error names its path; inspect it before clearing it.

## Launch and recover

After opening the project and its lane, call:

```json
{
  "action": "launch",
  "machine": "pennywise",
  "name": "drovr-worker",
  "role": "worker",
  "lane": "work",
  "label": "🔨 drovr worker",
  "clone": true,
  "brief": "/Users/joel/.agent/projects/drovr/briefs/work.md"
}
```

Use the real lane slug and brief. Fork and restore reuse the source row's machine. Cross-machine session transfer and remote side-desk adoption are not supported. Remote workers share their lane's remote tab; panes are never adopted from an explicit pane argument.

A remote `packet_report` writes its report and an atomic `packet.json` sidecar under the clone's `.pi/muster/packets/<id>/`. It does not touch a project catalog. Owner `project_status` ingests sidecars, and `packet_verify` also ingests before looking up an unknown id. Repeating ingestion does not reset a verified or landed packet. Non-ancestor follow-ups still need an outcome on the earlier packet.

Remote `owner_note`, worker `owner_reply` and packet notices also publish atomic sidecars under `.pi/muster/notes/`. Each holds the full owner-queue post, its CID, recipient and project/machine/row/lane identity. If intercom cannot deliver, the result says queued for the Flagg owner to pull, not delivered. Delivery latency is one owner status pass.

The same ingestion pass reads packets and notes in one bounded SSH call per row. It appends notes once by CID, preserves existing queue rows and rejects identity mismatches. Question, blocked and action posts retain their mention facets, so the existing owner feed wakes the owner just as it does for local posts. Quiet progress stays quiet. Repeated pulls do not wake the owner again.

Ingestion failures appear as board notes instead of failing the owner pass. A bad sidecar is skipped independently. After a machine transport failure, the pass skips its remaining rows and preserves their state. Verifying a packet already in the local catalog does not run ingestion; verifying a local worker packet never contacts SSH.

The owner verifies remote git and file evidence over bounded SSH calls, then fetches the worker branch over SSH for a local landing. Remote session mtimes are batched; cost is not read. Closing saves the pane tail locally and invokes the remote clone-removal script. A failed SSH read is not evidence that a pane disappeared.
