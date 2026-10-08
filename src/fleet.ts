import { Schema } from "effect";

const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String.check(Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))));
const Hosts = Schema.Array(Schema.String);
/** Only the status fields Muster consumes; fleet-compute owns the rest. */
export const FleetStatus = Schema.Struct({
  machines: Schema.Array(Schema.Struct({
    host: Schema.String,
    ageSeconds: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    reading: Schema.Struct({
      state: Schema.Literals(["live", "unavailable", "not-probed"]),
      data: Schema.optionalKey(Schema.NullOr(Schema.Struct({
        slots: Schema.optionalKey(Schema.NullOr(Count)),
        holders: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ held: Schema.Boolean })))),
      }))),
    }),
  })),
  queue: Schema.Array(Schema.Struct({
    id: Schema.String,
    project: Schema.String,
    repo: Schema.String,
    hosts: Schema.optionalKey(Hosts),
    eligibleHosts: Schema.optionalKey(Hosts),
    enqueuedAt: Timestamp,
  })),
});
export type FleetStatus = typeof FleetStatus.Type;

/** fleet-compute serves cached remote readings without probing; past this window holders are a guess. */
export const FLEET_FRESH_SECONDS = 60;
/** A missing ageSeconds is an older fleet-compute that sampled on the call; null means never sampled. */
export const staleReading = (machine: { ageSeconds?: number | null }) =>
  machine.ageSeconds !== undefined && (machine.ageSeconds === null || machine.ageSeconds > FLEET_FRESH_SECONDS);

const ordered = (status: FleetStatus) => [...status.queue].sort((a, b) =>
  Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt) || a.id.localeCompare(b.id));
const hosts = (ticket: FleetStatus["queue"][number]) => ticket.eligibleHosts ?? ticket.hosts ?? [];
const oldestMinutes = (queue: FleetStatus["queue"], now: number) => queue.length === 0 ? 0
  : Math.max(0, Math.floor((now - Math.min(...queue.map((ticket) => Date.parse(ticket.enqueuedAt)))) / 60_000));

export function gatesLine(status: FleetStatus, now: number): string {
  const parts = status.machines.map((machine) => {
    const { host, reading } = machine;
    const slots = reading.data?.slots;
    return reading.state !== "live" || slots == null ? `${host} off`
      : staleReading(machine) ? `${host} ?/${slots}`
      : `${host} ${(reading.data?.holders ?? []).filter((holder) => holder.held).length}/${slots}`;
  });
  if (status.queue.length > 0) parts.push(`${status.queue.length} waiting (oldest ${oldestMinutes(status.queue, now)}m)`);
  return `gates: ${parts.join(", ")}`;
}

/** Positions are one-based within each eligible host's queue, not the global queue. */
export function busyQueue(status: FleetStatus, project: string, repo: string, now: number): string {
  const queue = ordered(status);
  const ticket = queue.find((entry) => entry.project === project && entry.repo === repo);
  const positions = ticket ? hosts(ticket).map((host) =>
    `${host} ${queue.filter((entry) => hosts(entry).includes(host)).findIndex((entry) => entry.id === ticket.id) + 1}`).join(", ") : "";
  return `${positions ? `queue position: ${positions}` : `queue length: ${queue.length}`}; oldest waiter ${oldestMinutes(queue, now)}m`;
}
