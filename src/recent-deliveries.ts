export function deliveryId(event: unknown): string | undefined {
  return typeof event === "object" && event !== null && "id" in event && typeof event.id === "string" && event.id.length > 0 ? event.id : undefined;
}

/** A process-local bounded receipt index. Claim before an async handler to suppress in-flight duplicates. */
export function recentDeliveries(limit = 500) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("recent delivery limit must be a positive integer");
  const ids = new Set<string>();
  return {
    has: (id: string) => ids.has(id),
    claim(id: string) {
      if (ids.has(id)) return false;
      ids.add(id);
      if (ids.size > limit) ids.delete(ids.values().next().value!);
      return true;
    },
    forget: (id: string) => { ids.delete(id); },
    get size() { return ids.size; },
  };
}
