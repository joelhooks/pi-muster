# AGENTS.md

## Project shape

Muster 🐑 (`@joelhooks/pi-muster`) is the Pi package that runs Herdr project spaces: projects, lanes, packets, agents, and the desk. Bellwether owns the generic Herdr runtime. Muster imports only Bellwether's `exports` (`herdr-client`, `intercom`, `sidebar`, `wake`, `watch`) and never its extension file.

`skills/muster/SKILL.md` holds judgment only. If a rule can be enforced, it lives in a tool, and the skill does not restate it.

## Rules

- Extension startup is side-effect free: it registers tools, a flag, and a command, and opens no socket, file, or bus channel. Tools resolve everything at call time.
- Muster owns no clock. Cadence is a pi-until repeat the owner arms from `project_open`'s result. Muster never calls joelclaw.
- Every file read decodes through `src/domain.ts`. Every lifecycle change goes through `src/machines.ts`; rows carry one state, never a status beside it.
- Effect 4.0.0-beta.99 owns effects and typed errors. XState 5.32.5 owns lifecycles. Pure decisions (argv, tokens, silence, review proposals, cost) stay plain functions with tests.
- Never emit `--tools`, `--exclude-tools`, `--no-tools`, or `--no-builtin-tools`.
- Close a pane only by id plus terminal id, and only if Muster opened it. Act on a row's pane only from the session that owns it.
- Commits Muster makes are `shitratgit[bot]`'s. Muster never pushes.
- Durable state never lives under a temp dir unless the project is `ephemeral`.

## Checks

```bash
npm install --ignore-scripts
npm run check
npm test
npm run smoke
npm run pack:check
```
