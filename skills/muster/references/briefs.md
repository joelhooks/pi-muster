# Brief patterns

Most lane rework traces back to the brief, not the worker. These sixteen patterns name what a brief needs so the worker can finish without asking, and so the owner can tell done from not done. The [brief template](done.md#brief-template) lists the sections; this page says what makes each one work.

## Before dispatch

- **Checked premises.** Every claim about current code, a clone or another repo carries a citation (`file:line`, a commit, a version). The owner checks it before dispatch and the worker re-checks it before building. If one fact decides whether the lane is worth doing, make it a probe with a stop rule.
- **Authority before dispatch.** The files and the verifier that will judge the work already exist and are named. Don't invent the bar after the first packet.
- **Done is a ledger.** Acceptance is a finite list the worker can complete and count (call sites, cases, named suites with what they must run), not an adjective like "broad" or "relevant".
- **Fenced write scope.** Narrow shared files to symbols, and name each sibling lane and what it owns. Bring into scope what the change must break: existing assertions on changed strings, callers of a changed entry point, manifests for new dependencies, registered schemas for new tool inputs. Do the search yourself and name the hits.
- **Deploy level line.** State the level, its source, the rollback, and for ship-and-watch, the watch.

## The checks the worker runs

- **Worker runs the verifier.** The command the owner will judge with is in the brief, with its pass condition.
- **Related, then full gate.** Run related tests first, then one full gate on a committed tree that doesn't move. A load timeout in an untouched file gets one rerun, reported as both runs.
- **Canary before handoff.** A change to shared machinery (a renderer, the test harness, the launch path) runs the full consumer run or a canary that touches every path, before reporting.
- **Acceptance at the output.** Test what a person sees: the rendered text, the exact typed line, the frame at the narrowest width. Cover every input kind in a case matrix (local and remote, launch, restore and fork, legacy rows). Name what must survive. Reread acceptance lines for contradictions.
- **Zero is not a pass.** A check that ran no tests is a skip. A test that passed on rerun hasn't been repaired.

## Reporting and landing

- **Deploy, proof, signals.** The proof is a live check that doesn't depend on the changed code's own receipt, and covers every place the change runs. Record it with `lane_deliver`.
- **Packet per slice.** Each finished, committed slice is its own `packet_report`. A rejected call is fixed and retried; it isn't spent.
- **Results that wake.** Anything the owner must act on goes as `packet_report` or `owner_note kind=question`. Progress notes don't wake an idle owner.
- **Frozen receipt.** An artifact packet points at a write-once receipt, never at build output or a file anything will touch before landing.
- **Landing names its gate.** Land with a gate, or record what you checked instead. Gate where the code will run, or say what can differ there.
- **Redirect in the brief.** When the goal changes mid-lane, append a dated Redirect section that quotes the cause, says what it replaces, and retires lines it contradicts.

## The private Manual

A project may keep a private Muster Manual in its Brain at `.brain/projects/muster-manual/`. If one is there:

1. Before writing a section of a brief, read that pattern's page. Each page gives the failure, what the brief contains, and how to check it.
2. Before relying on your own reading of a brief, grade a few of the Manual's cards blind (front first, then the back) and compare with the expected reading.
3. After a retro, add a card for each rework the retro traces to a brief. Add a page only for a pattern with at least one real card.
4. Keep the Manual private. Its cards quote real briefs, paths and outcomes. Never commit it to a public repo.

If there's no Manual, use this page and the template.
