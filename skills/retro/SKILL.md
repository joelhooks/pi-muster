---
name: retro
description: Run a retro, a review of finished work that turns its friction into ranked, evidence-backed fixes. Use when Joel says retro, $retro, retrospective, "what went wrong", "review the finished lanes", "full project retro", or names a scope to review ("$retro <path or project>"), and when a lane_close note says a retro is due. The owner launches a read-only judge lane; the judge follows the procedure in the muster skill's references/retro.md.
---

# Retro

A retro reviews finished work and returns ranked environment fixes: parked lanes and desk decisions. It never fixes anything itself. Its purpose is to improve the process and the code toward the project's `VISION.md`, so rank candidates by how far they move the project toward it.

Retros are standard practice, not optional. Every project runs them on a cadence, in the standing retro slot outside work WIP.

## Cadence

A retro is due when either is true, and the owner's cadence pass launches it without being asked:

- three work lanes have closed since the last retro (the flow line shows `retro: due (N closed)`, and `lane_close` names the slug);
- a day has passed since the last retro and at least one work lane has closed.

Skip it only while a retro is already running. Don't stack them.

## Model

The judge runs on `openai-codex/gpt-6-astra` at `xhigh`. When token burn is heavy (a long batch, many sessions, or the project's spend is already high), use `openai-codex/gpt-6.1-sol` at `high` instead, and say so in the brief.

## If you are the owner (a desk or boss)

1. **Scope.** The default batch is the work lanes closed since the last retro (`project_review` lists them as `retroLanes`). When Joel names a scope (a path, a project, or "the whole project"), that scope is the batch. Put his words in the brief.
2. **Open the standing slot.** `lane_open` with `kind: "retro"` and the slug from the `lane_close` note (or `retro-<YYYY-MM-DD>`), even at full WIP. Only one retro runs at a time.
3. **Brief.** Name the scope, the evidence (sessions, packet reports, closed tails, gate logs, retros already done), the questions that matter most, and one absolute artifact path under `.brain/data/muster/retros/`. Tell the judge to follow `../muster/references/retro.md`.
4. **Launch a judge.** `agent_launch` with `role: "judge"`, `cwd` the project dir, and the model from [Model](#model). When Joel names a different model, use exactly that one.
5. **Land and route.** `packet_verify`, then `packet_land committed` (artifact packet), then route each candidate: parked lanes with `lane_open open: false`, decisions with `desk_post`. Then `project_review retro: true`.

## If you are the judge

Follow [references/retro.md](../muster/references/retro.md) exactly: bounded session slices, cited evidence, ranked candidates, one artifact packet. Read-only: no edits to code, skills, or steering files.
