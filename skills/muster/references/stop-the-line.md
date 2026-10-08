# Stop the line

Joel may say "stop the line", "freeze", or "only essentials and monitoring for 24h". That means stop all project work for a set window, for safety and token cost. Production and monitoring keep running.

The desk owns the stop, the page watch and the resume timer; only Joel ends it. Bosses, the hawk, judges and arbiters are opt-in for a named risk. Open or retain a hawk only for a monitoring risk you can name, such as a long unattended production run, and record it on the lane or in the launch. Below, “monitor” means the desk unless it delegates that risk to a hawk.

## 1. Relay the terms, within minutes

- **Record the stop terms**, and send them to an opted-in monitor if separate from the desk. They give:
  - the window in UTC, both ends;
  - the purpose;
  - who holds the watches at low thinking (§6);
  - a **STOP** list, a **KEEP** list, and the resume rule (§2);
  - one desk item with the freeze state before stopping (§3).
- **Give writers the terms.** They start no new packets, merges or measurements.
- **Update the project:**
  - Set the `headline` to "⛔ Line stopped until <end>".
  - Set `nextAction` to the resume checklist.
  - Set the policy's `nudgeAfterMin` to at least the window in minutes and `restartAfterMin` to `null`. That keeps owner passes from nudging or restarting parked rows.
- **Park open desk decisions that can wait.** Resolve any that were superseded, noting "parked until restart".

## 2. The terms

**STOP**

- **Merges and deploys.** A deploy already in flight either finishes through its post-check or rolls back, then stops. The deploy gate gives no GO.
- **New work.** No new packets, lanes, load tests, stage waves or measurement runs.
- **Clocks that wake an agent.** Every `until repeat` or tick that wakes an LLM on a schedule stops.
- **Agents.** Workers stop at a clean checkpoint and write a handoff. Any opted-in bosses and reviewers go idle. The monitor keeps the watches (§6).

**KEEP**

- **Production.** It keeps running, and so do the product's automated sends.
- **The paging route.** Verify it end to end: alerts must reach Joel's phone. If the route isn't live, making it live is the one change allowed.
- **Alert watching.** Watch alerts with a shell-condition `until` that wakes an agent only when an alert fires. No LLM turns while things are quiet.
- **An emergency exception.** A real production incident gets a rollback, or the smallest fix, through the deploy gate. It is reported to the desk queue.

**Resume.** At the window's end, one desk item asks Joel whether to resume. Nothing resumes on its own.

## 3. The freeze-state item

Post one `fyi` desk item that Joel can read in a minute. It has four parts:

- **Held:** each PR, deploy step and date that slips.
- **Stopped:** what paused, and what that costs. Example: "straggler events wait as retryable; nothing is lost."
- **Still running:** production, automated sends, the page route, and any dormant watches.
- **Resume:** when the resume question will come, and a note that nothing restarts until Joel answers it.

## 4. Close and catalogue

Joel may also ask to close the sessions and panes. Keep the desk open, plus an opted-in monitor if it holds the watches.

1. **Write the roster first,** as a Brain note. For each agent it records:
   - the role;
   - the pane;
   - the full session ID;
   - the model and thinking level;
   - the cwd;
   - its restore command.

   Muster rows restore with `agent_launch action=restore`. A claude-bridge session needs one typed prompt after a restore before its wakes work.
2. **Busy agents get one message:** "Finish the current tool call, write a handoff, and end your turn. No commit, no merge, no reply." Wait for the pane's `agent_state` to reach idle or done (a finished Pi reports `done`, so watch `until=[idle, done]`), then close it.
3. **Idle or done agents** close now.
4. **Close Muster rows with `agent_close`,** which saves the pane tail and the restore command. Use a raw `herdr_pane close` only for panes outside the catalog, and add those to the roster.
5. **Leave work in progress uncommitted in its clone.** A commit runs the full hook, and unfinished work may fail it. Never use `--no-verify`. Never remove a clone.
6. **Record close receipts** on the roster: who acknowledged, and who was idle but unconfirmed.

## 5. Watches die with their session

Pi-until watches and Herdr watches belong to their session. Closing the session that holds the page watch or the resume timer kills them. Keep their holder open, whether it is the desk or an opted-in hawk.

If watches must move anyway, arm them in the new session first, wait for its `fyi` saying both are armed, and only then close the old one. Never leave a gap.

## 6. The monitor

The desk holds the watches by default. A hawk is opt-in for a named monitoring risk recorded on the lane or in the launch. If that risk warrants a separate monitor, there are two ways to retain coverage:

- **The same monitor.** It calls `thinking_set low` and takes the freeze brief below. Its watches and context carry through.
- **A fresh third-shift Hawk.** Use this only for the recorded risk when the existing hawk's context is heavy or Joel wants a clean start.
  1. Launch it on the Hawk role with low thinking, compact-at 200000 and the freeze brief.
  2. It arms its own watches and posts an `fyi` saying both are armed.
  3. Only then close the day Hawk, which goes on the roster for restore.

  The third shift reads only the brief, the roster, the freeze-state item and the last lines of the Hawk handoff. The day Hawk's session and handoff are lore: it searches them when a question needs it and never loads them whole.

The freeze brief:

- **Watches:** a page watch on a shell condition (no LLM turns while quiet), plus the resume timer.
- **Authority:** one named incident class, such as email delivery, and a fixed list of actions:
  - read-only diagnosis;
  - retries through the existing operator paths;
  - reverting a switch to its last known-good value;
  - restoring the deploy gate and a deploy worker for a rollback or the smallest fix (prefer the rollback);
  - restoring one worker when the fix needs code.

  Every deploy keeps its gate and its post-check.
- **Off limits:** everything else, and any new class of risk: new audiences, DNS, deleting data. Those go to Joel through the desk queue.
- **Reporting:** the desk queue only, one item per incident. When Joel is needed urgently: a `blocked` item plus one `needs_joel` ping.
- **No recurring ticks.** The monitor wakes only on a watch.

## 7. Work inside the freeze

Joel can approve work during a freeze. Each time, record the fence: what is approved (build, merge) and what still waits (deploy).

A paused project's local main goes stale. Fetch origin before cutting clones, and confirm each clone's base against `origin/main`.

## 8. Resume

When Joel says go:

1. The monitor returns to its usual thinking level. Retain a hawk only while its named risk remains; hand watches back to the desk before retiring it.
2. Restore the writer, then the deploy gate.
3. The desk decides which lanes come back. Items with a deadline go first.
4. Put the policy back (the silence limits), along with the headline and the owner loop.
5. Re-plan anything the freeze voided.
6. Mark the roster note done.
