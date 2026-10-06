# Gotchas Muster cannot enforce

Traps from the first pilot projects (2026-09) that stay judgment. Anything that became code is gone from this list: cwd checks, launch order, session ids from Herdr, proof of delivery, the silence check, tool allowlists, pane ownership, temp-dir state, the heavy-job lock, and landing as the bot.

- Launch and fork start Pi with the work message in argv (long text uses a private `@file`); only `exec sh <private launcher>` is typed. Restore sends a message only for an explicit `prompt` or `brief`; saved restore argv never carries it. Names are set after detection for watches, never delivery; a refused rename reports the holder without stealing.
- Remote startup failures retain a private per-launch stderr log under the worker's Git metadata (`muster-launch/launch-*`, or `.pi/muster/launch-*` for a non-Git cwd); inspect the error and row events before retrying, even when the pane has disappeared.
- The immediate launch receipt contains no delivery proof. The owner-queue action carries the full result; arm the pane watch after that action. A dead launch job is marked failed by `project_status`, never re-spawned automatically. Inspect the named log before retrying.
- An unproven launch result includes a single repair call; first-turn proof waits up to 90 s and rejects paste markers and assistant errors. Read the pane and session first; a prompt already working must not be sent again. A current-code desk must restart after an update to use the new launch behavior.

- Restore reads the session's latest model and thinking changes; explicit overrides win. If context/window evidence is unavailable, the receipt warns and proceeds: verify the target window before sending the next turn.

## Bridge lanes (`pi-claude-bridge`)

- Prompt capture fails closed on wakes. An intercom, pi-until, or `sendMessage` wake skips `before_agent_start`, so the bridge must match Pi's live prompt to one it recorded on a user turn. After a `/reload` or restart that changed tools, rules, skills, or custom sections, nothing matches, and every wake ends with `stopReason: error` and 0 tokens until an ordinary user message refreshes the capture. A lane woken only by timers never gets that message. `project_status` types that message into its own stuck lanes and shows others' as `⚠️ stuck`; `agent_launch action=restore` sends it with the work prompt.
- A spent quota ends every bridge lane's turn and nothing resumes them. After the reset, re-prompt each lane. Switch accounts near a limit; if every account is past 80% of its 7-day window, stop opening Opus lanes.
- Mid-turn compaction continues on a fresh Claude Code process and loses the prompt cache about 58% of the time. The cold first turn after compaction often runs without tools until the bridge's listing gate covers every fresh query. Do not lower compaction thresholds on live lanes before that fix lands: every lane above the new line compacts on its next turn at once.
- Opus lanes near 975k fail one request with "Prompt is too long". Per-role `--compact-at` keeps them far below.
- The bridge cannot run inside pi-subagents children.
- Bridge workers' own `until` wakes often fail to resume them. Workers run suites and deploy rungs in the foreground with a long bash timeout.

## Talking to lanes

- To park a lane, use `lane_open open: false`; `lane_close discard: true` drops proposed work from the backlog without counting it as finished work.

- Intercom delivers when the recipient's turn ends. To steer a running turn in a pane you own, type into it.
- Address sessions by the exact id in the catalog, never by cwd.
- Chatty intercom drowns owners: in one pilot, 34 of about 985 messages were results. FYI, progress and done go to `owner_note`, not intercom. Questions go to `owner_note kind=question`; answers thread through `owner_reply`.
- Never tell a worker to `/quit`. In a tiny pane it arrived as the chat message "quit". Close the pane after sign-off with `agent_close`. With current Bellwether pane-close bus support, Muster retires the owner's matching watches before closing and reports `watches retired: <ids>`. On older Bellwether, cancel watches first with `herdr_watch action=cancel`, including named targets; fallback receipts name candidates, not confirmed live watches.
- Pi 0.79.10 (Muster's development pin) ignores `triggerTurn: false` while streaming: `sendCustomMessage` queues default delivery as steering, including at `agent_end`. Custom cards become user messages at the model boundary, so the bridge sees prompt input, not the trigger flag. Newer fleet Pi explicitly keeps non-triggering streaming messages out of steering. Check the desk's loaded Pi version before blaming the bridge. Self-post suppression removes our own cards before either path; foreign delivery is unchanged.

## Heavy jobs and fleet gates

`muster-heavy` is on PATH in Muster-launched agents and the loaded owner's shell; otherwise run `node <pi-muster>/bin/muster-heavy.ts`.

- Use `muster-heavy gate --wait 1200 -- <cmd>` for worker and owner gates. Fleet-compute owns routing and queueing. Pass `--host flagg` for host-bound checks. Commit first or pass `--tree <git write-tree SHA>`. Keep `pack:check` and `smoke` local. Unset old deploy-window and grant environment variables for the unchanged `gate` entrypoint.
- Installed fleet-compute owns landing gates: its receipt decides success, including gate exits 2 or 75. A lost run (`exit: null`) fails closed. The private index and committed tree must match the receipt.
- Local `muster-heavy -- <cmd>` registers and starts immediately. It has no admission, slots, grants, queue, exclusive holds or caps. Old flags and admission environment variables do nothing and produce one ignored-settings line. Do not rely on them to serialize a deploy.
- `status --json` lists live jobs and tree CPU/RSS. Its legacy slot fields retain spare capacity. The configured memory floor (default 16 GB) remains available to fleet placement, not local admission. Available memory includes reclaimable macOS pages or Linux `MemAvailable`. `report --since 24h --json` groups finished and lost jobs by repo and command. Peak RSS is sampled every five seconds; final CPU-seconds come from process accounting. A dead job without an exit is marked lost on the next status/report pass.

## Workers and the fence

- Bump `CATALOG_WRITER_SCHEMA_VERSION` in `src/store.ts` whenever persisted fields are added (including nested fields); the write fence requires every writer to have loaded fence-aware code, so restart pre-fence sessions before relying on it.

- In `rift-merge`, clones follow the source's local branch, even behind origin; check the launch base note, and set `lane_open base` to override it (detached sources retain the script default).

- If the repo's Brain check rejects the board's frontmatter type, set `boardType` through `project_open` or `project_update` to a type its rules allow.

- A live worker can report an ancestor follow-up before its verified packet lands; committing the follow-up lands both, while rejecting it leaves the earlier packet open.
- An artifact's packet id names the bytes at `packet_report`, not a mutable file. If verification finds changed bytes, record the old packet `rejected` with evidence, then have the worker report the current file. The owner can also record `no_changes` when that is the actual outcome. Neither outcome needs verification; a `committed` outcome still does.
- Squash-only repos land through `landedAs <squash sha>`; Muster checks the squash by patch-id or by the packet's touched paths.

When a larger squash changes the same paths, a dirty clone fails verification, or a packet was ported onto another branch, the owner can use `packet_land outcome: committed attested: true landedAs: <sha> evidence: <what you checked and where>`. Muster proves only that the landing commit is on the source's base branch, fetching origin refs without touching the clone. It records `attested: true` and owner-attested evidence, not successful verification. Superseded packets get the same marker. Agents in reported or verified state step to landed; other states remain unchanged and appear in the result note.
- A gone clone verifies against the source checkout (including its remote-tracking refs and squash patch-id); land it with `landedAs`, or record `rejected` / `no_changes` with evidence when the source lacks the commit.
- After a worker starts a sibling branch, verify its next packet before landing or closing: successful verification records the containing branch in `clone.branch`.
- A worker merges the target branch into its clone and reruns the full gate before reporting. A packet that does not land clean costs a round trip.
- Workers stage by path. A clone keeps its source's ignored files, such as `.env*` and `node_modules`, and `git add -A` with a loose ignore file sweeps them in.
- A watch that waits on results re-fires on items already handled unless it keeps a seen set. Append handled ids to a file, and arm the next watch in a later tool call, never in the same batch as the write. A Muster desk needs no watch for its own queue: the desk feed keeps the cursor.
- Never edit a script while a pane runs it; bash reads the file as it goes.
- `shitrat push` can exit 0 on failure. It pushed only when its JSON says `ok:true`. Gate pushes with `if <gate>; then push; fi`, never `gate | grep && push`.
- CI budgets in absolute milliseconds flake on runner variance. Compare against the parent build in the same run.

- `packet_report` runs in the worker's own Pi, so the worker's loaded Muster decides what it may do. After a Muster fix to reporting, restart the worker with `agent_launch action: "restart"`. Restarting the owner changes nothing for the worker.

## Restore

A manually restarted desk does not need a second Pi process. The owner's `project_status act: true` re-adopts an interrupted row when its session is live in the project's workspace; moved silent, nudged, and restarted rows use the same check. A direct fork matches the session header's `parentSession` path and updates the row's session file and id. If two panes carry the same session, choose one with `agent_launch action: adopt name: <row> pane: <pane>` (no `side`). Adoption changes only the catalog, never sends input, and leaves panes bound to other rows alone. A replacement terminal is not marked as opened by Muster, so closing the row leaves that terminal open.

- Takeover forwarding is project-scoped; restart every desk after this update before lifting the takeover ban, and leave legacy posts without a project in their original session's inbox.

- Owner queues are per session, separate from Joel's desk queue. `/new` changes the address. A takeover forwards old owner queues, including posts from workers still on old code. Reload the new owner to load forwarding-aware readers. `owner_inbox` labels forwarded records `via <old owner short id>`. History since the old reader's last heartbeat may replay because its exact consumption point is unknown. Replies still target the parent's author, not an agent name. Stale or absent readers fall back to intercom for mentions.

- `IllegalTransition … expected verified` from `agent_close` can mean the desk still has the pre-`3332978` CLOSE caller loaded; restart the desk before judging the landed fix, and do not treat a retry on old code as live proof.
- `agent_close` removes a worker's clone. Its restore command still names that cwd, so restore into a fresh clone (`cwd`) or fork from the row.
- A pane that comes back after `/new` may be on the pane's default model. Restore from the catalog when the context is worth keeping.
- A desk restored with a plain `pi --session` loses its queue digest. Its row carries `HERDR_DESK_PROJECT` and the desk extension.
