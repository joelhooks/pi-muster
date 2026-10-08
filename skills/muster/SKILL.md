---
name: muster
description: Run a project as a Herdr space of lanes with Muster 🐑, the project manager on top of Bellwether. Use when Joel says fan out, fan-out, fanout, spin up lanes, lane boss, hawk, desk, judge, or project space, or asks for pane workers, parallel writers, harvests, packet verification, landing lane work, the desk queue, stopping the line (freeze, pause everything), or a weekly project review. This skill holds judgment; the Muster tools enforce the mechanics.
---

# Muster 🐑

One writer, one gate, one accountable desk. The desk owns the project. Each lane has one writer, a worker who reports directly to the desk. The desk may also be the writer. The land gate is the proof of the candidate; extra agents are not extra gates.

One project per Herdr space. Tabs are lanes. Muster's tools own launch profiles, catalog rows, lifecycle states, packet evidence, landing, queues, and sidebar tokens. This skill covers only what the tools cannot decide.

## Start here

A project dir must be private, never a public repo's checkout; lanes point `repo` at public code. Work belongs to a registered project, not an unowned set of panes.

A space that serves two outcomes is two projects. Split at the weekly review, not mid-pass. Send work for another project's outcome to that project's desk. A new project or a different PARA area goes to the Switchboard with Joel's words and your read of where it belongs. Don't divert your own desk or open the other project yourself.

A shared platform's desk keeps main and the deploy gate; tenant desks own their asks. Running another tenant's deploys must not displace the project's own outcome.

## When to add people

Bosses, the hawk, judges and arbiters are opt-in for a named risk. Record the risk on the lane or in the launch before opening the role. Examples: many packets touching shared files, a long unattended run, or customer money. Pick the role that addresses that risk, and remove it when the need ends. There is no standing judge slot.

- Fan out only when the critical path needs a second writer now. Every extra lane costs owner attention and a cold prefix.
- Parallel lanes need disjoint write scopes. One writer per checkout; everyone else reviews a named hash.
- A short fan-out does not require a boss. The desk remains accountable unless a named coordination risk warrants one.
- A read-only, headless probe can be a native subagent. Anything that writes, runs long, or needs restoration belongs in a lane.
- Use a side desk when Joel wants to explore an evolving design alongside the main conversation. Keep execution with the parent desk; the side desk hands over briefs and decision notes.

## How to cut a lane

- Name the smallest user-visible outcome. The desk owns it end to end; the writer delivers the bounded slice.
- Cut packets by write scope and by what fits the time available. Park an outcome you cannot name yet rather than launching it.
- An unready dependency gets a placeholder packet, not a blocked lane.
- Separate code and live-config writers when the release needs both now. Keep their scopes disjoint and prove the combined candidate at the land gate. Independent review is opt-in for a named risk, not an automatic third lane.
- Briefs live in the project's Brain, never `/tmp`. Read the [done and brief template](references/done.md#brief-template) when cutting a brief, and [brief patterns](references/briefs.md) when a section needs judgment.

## Keep work flowing

The WIP limit is a ceiling, not a target. Finish one slice before expanding the program. Keep a ranked backlog of proposed work with briefs so the next useful slice is ready. A role lane that lands commits is a work lane in disguise.

Use median cycle time over the last ten proven lanes and throughput over the last seven days to judge flow. Lanes are continuous work, not sprints.

Retros run only after an incident (a bad landing, outage or lost work), friction that repeats across lanes, or when Joel asks. Name the trigger and bound the scope in the brief. Use [finished-lane retro](references/retro.md); there is no count- or day-based cadence and no automatic retro at project review. Route findings into the backlog without holding unrelated delivery.

Deploy posture belongs in the project's VISION.md, in Joel's words. Choose the least permission the work needs: customer-facing work, money, outbound sends and slow rollbacks stay conservative; irreversible work needs approval. A research experiment can ship and watch, or skip proof when its rollback is cheap. Keep watching lanes visible to the desk whether or not a retro runs.

## Shape it to the job

Role models and alternates come from the fleet roster. Pick an alternate when its stated purpose matches the lane. An explicit model from Joel wins. Give workers only the skills their packet needs.

Long builds need silence limits that allow them to finish. Cheap scouts need less context; a lane that must retain context needs a suitable compaction limit. Change project policy rather than working around it.

A launch receipt is not a live agent. Inspect blocked launch evidence before retrying. After a dependency upgrade, restart Pi rather than relying on a reload to replace cached modules.

Warm-fork related work only after the source context is ready, with a fresh brief and separate checkout for another writer. An overruled instruction needs corrected conversation context, not a stack of “ignore that” messages. Rewinding context does not undo files or commits.

## Names and the sidebar

Callsigns are display names, not routing ids. Each project picks one obscure pop-culture theme; callsigns are one word and unique across the fleet. Keep row names, agent names, session ids, lane slugs and tab labels stable.

The space label is the project's name, not its status. The headline says what the space is doing now, not what happened on every pass. Title a desk item as Joel's action: “merge #1152”, not “PR question”.

## What counts as proof

Read [done means live and proven](references/done.md) when finishing delivery. Merged is not live. The land gate proves the exact candidate; live proof demonstrates the deployed outcome.

- A packet report is a claim, not proof. Screen state, `DONE`, age, or a commit alone are not evidence.
- Use one authoritative land gate for the candidate. Changed candidate or coverage needs fresh proof; another management role does not replace it.
- A customer-facing check counts only when loaded signed out, as the recipient sees it.
- A deploy gate needs a captured base-versus-head surface diff. An allowed-diff list reasoned from code is not evidence.
- Move a rollback target only on CLEAN, and write the verdict line last. Never turn a failed or partial gate into a pass.
- Artifacts need acceptance evidence, not a fictional deployment.

## Escalation and communication

- Workers report to the desk, not through a mandatory boss or hawk. Workers have no path to Joel.
- The desk answers from source first. Escalate a genuine authority question with evidence and a recommendation, not a relay of routine progress.
- When Joel delegates an operation, record its scope in the handoff. Within it, the desk rules on execution choices. A new class of risk goes to Joel: customer sends beyond approval, broader production code, durability changes, deletion.
- When Joel stops the line, use [stop the line](references/stop-the-line.md). Keep a hawk only for a named monitoring risk, recorded on the lane or in the launch. Only Joel resumes.
- A desk holding several decisions for Joel publishes one [desk report](references/desk-report.md), not a chat digest.
- Use plain sentences with spaces between words; put code, paths and ids in backticks. Quiet progress belongs in the owner queue; one packet report is the finish report.
- Coordinate interfaces, shared files and ordering directly across lanes. Never write in another lane's scope. Record shared decisions once in the project's Brain; disagreements go to the desk.
- Ask another project's desk for what it owns. Include sender and receiver, one concrete ask, receipt paths, and what you ruled out. The receiving desk acknowledges and returns the shipped result or a reason to decline.
- Touch another project's pane only when its session asks, and only for what it asked. Never hand-edit another project's catalog.
- Never act on GitHub as Joel. Use the ShitRat bot or ask.

## Clocks and cost

Pi-until owns every clock. Keep owner passes under 60 minutes; the prompt cache goes cold after an hour. An empty pass ends in one line. The desk may write and diagnose directly; delegate only when the critical path or a named risk warrants it.

Read [remote lanes](references/remote-lanes.md) for worker panes on a saved machine. The desk and landings stay on the owner machine. Read [gotchas](references/gotchas.md) when a lane stalls, a bridge lane misbehaves, or restoration surprises you.
