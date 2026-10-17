# AGENTS.md

## Project shape

Muster 🐑 (`@joelhooks/pi-muster`) is the Pi package that runs Herdr project spaces: projects, lanes, packets, agents, and the desk. Bellwether owns the generic Herdr runtime. Muster imports only Bellwether's `herdr-client` export and never its extension file.

`skills/muster/SKILL.md` holds judgment only. If a rule can be enforced, it lives in a tool, and the skill does not restate it.

## Freeze (2026-10-13)

Muster is being strangled down to its Herdr hands: spawn, fork, restart, adopt, locate, prompt, interrupt, readPane, clone create/assess/remove, closePane and layout. Joel approved a freeze: no new features outside those hands. Bug fixes to existing behaviour still land. New coordination features (queues, lanes, landing, cleanup, routing) go to their new owners, not here.

## Rules

- Extension startup is side-effect free: it registers tools, a flag, and a command, and opens no socket, file, or bus channel. Tools resolve everything at call time.
- Muster owns no clock. Cadence is a pi-until repeat the owner arms from `project_open`'s result. Muster never calls joelclaw.
- Every file read decodes through `src/domain.ts`. Every lifecycle change goes through `src/machines.ts`; rows carry one state, never a status beside it.
- Effect owns effects and typed errors. XState owns lifecycles (versions pinned in `package.json`). Pure decisions (argv, tokens, silence, review proposals, cost) stay plain functions with tests.
- Never emit `--tools`, `--exclude-tools`, `--no-tools`, or `--no-builtin-tools`.
- Close a pane only by id plus terminal id, and only if Muster opened it. Act on a row's pane only from the session that owns it.
- Commits Muster makes are `shitratgit[bot]`'s. Muster never pushes.
- Running sessions load new code at their next natural restart. Add a `Restart-Needed: <why>` trailer only when a live session on older code would do harm or fail: a changed tool schema, a cross-session protocol change, or a bug that hurts while loaded. Only marked commits warn running sessions. When in doubt, mark.
- Durable state never lives under a temp dir unless the project is `ephemeral`.

## Checks

```bash
npm ci --ignore-scripts --prefer-offline   # never npm install: it rewrites package-lock.json
npm run check
npm test
npm run smoke
npm run pack:check
```

The full gate runs the suite capped at two workers; uncapped runs time out on a busy host:

```bash
muster-heavy gate --wait 1200 -- sh -c 'npm run check && VITEST_MAX_WORKERS=2 npm test'
```
