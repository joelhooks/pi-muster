# Fleet steer writer contract

Muster reads `~/.local/state/muster/fleet-steer.json` on the owner's machine at worker launch time. The steer job owns writes; Muster never writes this file. Publish a complete JSON file atomically so readers do not see partial writes.

```json
{
  "at": "2026-10-09T22:00:00Z",
  "validUntil": "2026-10-10T00:00:00Z",
  "workerDefault": "opus",
  "claude": { "pace": 1.0 },
  "codex": { "pace": 0.5 },
  "source": "fleet steer job"
}
```

`at` and `validUntil` are ISO timestamps with a timezone. `workerDefault` is `sol`, `opus`, or a `provider/model` route. `claude`, `codex`, and `source` are optional. Pace values are numbers; Muster does not use them. Extra fields are ignored. `FleetSteer` and `decodeFleetSteer` in `src/domain.ts` own the schema.

A steer is fresh only while `now < validUntil` and `now - at < 3 hours`. At either boundary it is stale. Missing, unreadable, undecodable, or stale files fall back to the roster, then built-in defaults, with a reason in launch notes. Model routes still pass Muster's existing model guard.

Precedence for worker launches:

1. Explicit launch model.
2. `policy.roles.worker.model`.
3. Fresh steer `workerDefault`.
4. Roster worker model, then `ROLE_DEFAULTS`.

Desks, hawks, bosses, and judges ignore the steer. Restore and fork keep their existing model selection. Launch notes name the selected model and its source. Remote workers use the owner's steer; existing provider mapping still applies on the target machine.
