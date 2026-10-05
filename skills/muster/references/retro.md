# Finished-lane retro

Improve the agent's environment from finished work, not from guesses about the chat. Run after three closed work lanes since the last retro, and at every `project_review`. Three is the tool's default reminder threshold; an owner can commission an earlier review or choose another batch size in the judge's brief. Muster starts no timer and launches no agent automatically.

## Dispatch

Open the standing slot with `lane_open slug: "retro" label: "🔁 retro" goal: "Review finished lanes" kind: "retro"` even at full work WIP; only one retro lane may be open or draining. The owner launches a short-lived judge-role agent with the selected lanes, read scope, and one absolute artifact path under `.brain/data/muster/retros/`. Use `project_review`'s `retroLanes` and worker session files to form the batch. A `lane_close` reminder means at least three lanes are awaiting review, not that another judge should launch while one is already running.

The judge returns an artifact packet containing ranked findings in a `.svx`. It never edits steering files, skills, or code inline. The owner verifies and records the artifact, routes candidates, then calls `project_review` with `retro: true` to set `lastRetroAt`. Ordinary project reviews do not consume the batch. Finish a pending batch before closing more lanes: this marker records completion time, not a selective per-lane cursor.

## Evidence per lane

`project_review` lists each pending lane's worker sessions from agent rows, closed and restart tails from exact agent-name filenames in `closed/`, and reports from packet rows; the `lane_close` reminder names that call.

- Worker's session file: the row's `sessionFile`, or `agent_close`'s `restore:` line.
- Every packet report under `.brain/data/muster/reports/<lane>/`, including rejected and follow-up packets.
- Closed pane tail under `.brain/data/muster/closed/`.
- Owner rework and scope-expansion messages, including their response.
- Gate logs named by the reports and the owner's landing evidence.

Read transcripts through session tools in bounded slices. Start with `session_inspect` on the named session and a specific event; refine the query or use `session_context` for a bounded summary. Never load a whole transcript. Cite session id and line window, report path, or gate path and line numbers. Redact secrets; findings summarize evidence rather than copying raw transcripts. If a source is missing, record the gap and lower confidence. A terminal tail or report is not independent proof of every claim.

## Look for

| Category | Question |
| --- | --- |
| Navigation | Was a dependency or renderer hard to find? Would a conditional pointer help? |
| Automated checks | Could a deterministic check catch the error? Read the repo's checks and CI first; repair unwired checks instead of inventing duplicates. |
| Coding standards | Did review miss a judgment call? Mechanical patterns belong in a deterministic check, not another written rule. |
| AGENTS.md bloat | Can reviewer-only guidance or checkable rules leave the always-on prompt? |
| Tool economy | Did broad reads, repeated calls, or duplicate wakes waste context? |
| No-op instructions | Which instructions failed to change behavior? Require evidence before proposing removal. |
| Information access | Were logs, source, records, or readonly capabilities missing or stale? |
| Brief quality | Did rework or a scope change trace to an omitted case, caller, output surface, or ownership seam? |
| Muster tool gaps | Did launch, verify, land, or close fail or require a retry? Separate the observed failure from its suspected cause. |

## Return ranked candidates

Rank by impact and recurrence: high for blocked delivery or repeated rework, medium for avoidable round trips or repeated context cost, low for local friction. Include confidence, category, evidence, the failure mechanism, the smallest environment improvement, and a check that would prove it. Prefer checks over prose when the behavior is mechanical. Compare with existing lanes and shipped fixes; mark duplicates or already-fixed symptoms rather than dispatching them again.

Each actionable candidate proposes one of:

- **Parked lane:** a slug plus a one-paragraph brief stub naming outcome, narrow write scope, guardrails, and proof. The owner creates it with `lane_open open: false`; the judge does not set priority.
- **Desk decision:** a `desk_post` draft with the question, evidence, and a recommendation when Joel must choose scope, risk, or policy.

Mark explained-away examples and missing evidence explicitly. The artifact does not claim a lane was created or a decision posted until the owner has a tool receipt. Do not treat a green rerun alone as a repaired check.

## Source

Adapted in our own words from [Matt Pocock's retro skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/retro/SKILL.md), MIT licensed, Copyright 2026 Matt Pocock. Its distinction remains: implementation owns exploration and fixes; review owns judgment standards. This version adds finished-lane evidence, brief quality, Muster tool gaps, and artifact-to-backlog routing.
