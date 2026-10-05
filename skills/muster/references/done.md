# Done means live and proven

A merged packet is not a finished lane. The owner carries delivery through five checks:

1. **Built:** committed, with tests that fail without the change, and the gate passes.
2. **Landed:** merged to main and pushed with `shitrat`.
3. **Deployed:** live where it runs. For pi-muster, pull on the hosts and reload the sessions using it; check the version-skew warning. For a project repo, ship behind a flag when behaviour changes.
4. **Proven:** record a check against the live system, not the test suite.
5. **Observable:** name one working signal, one failing signal, and where each appears. Record the flag state and rollback.

For docs-only work or a probe with nothing to deploy, record why delivery is waived. Rejected and `no_changes` packets need no delivery. Closing a tab does not prove its work live.

## Keep the next lane ready

After proving or closing a lane, pull the top ranked lane when its WIP slot opens. The desk keeps proposed lanes briefed and ranked so the owner can refill without another planning pass. Joel can change the order. See [Keep work flowing](../SKILL.md#keep-work-flowing) for the pull policy and its cycle-time and throughput measures.

## Brief template

- **Outcome:** what changes for the user.
- **Premises:** cite every claim about current code with `file:line`. The worker checks each before building and reports any false premise.
- **Write scope:** the files this worker owns.
- **Existing tests:** before dispatch, the owner searches tests for changed strings, labels, and symbols. Name each hit in write scope as "update only these assertions"; fence parallel lanes by test name, not whole test file.
- **Case matrix:** for branch, ref, or verify work, list cases and expected results.
- **Caller map:** before changing an entry point's contract, name its callers and what each expects.
- **Acceptance:** check the rendered output and name the renderer's file.
- **Consistency:** the owner rereads acceptance lines for contradictions, such as "messages byte-identical" plus "add a hint to the messages".
- **Checks:** regression tests, a red proof, and the full gate.
- **Deploy:** how it goes live, the flag state, and the rollback.
- **Proof:** the live check the owner should run and where its evidence will be recorded.
- **Signals:** `{ working, failing, where }` in plain words.
- **Report:** commit as ShitRat, then call `packet_report` once with the commit, checks, `deploy`, `proof`, and `signals`. Do not push unless the brief authorizes it.
