import { existsSync, mkdirSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = Pick<SessionManager, "getEntry" | "getEntries" | "getLabel" | "getBranch" | "getLeafEntry" | "getLeafId">;

/** Pi owns decoding, migration, tree paths and label replacement semantics. */
export function openSessionTree(file: string): SessionManager {
  if (!existsSync(file)) throw new Error(`session file does not exist: ${file}`);
  return SessionManager.open(file);
}

export function resolveSessionTarget(tree: ReadonlySessionManager, target: string): string {
  if (tree.getEntry(target)) return target;
  const labelled = tree.getEntries().filter(entry => tree.getLabel(entry.id) === target);
  if (labelled.length === 1) return labelled[0]!.id;
  const labels = [...new Set(tree.getEntries().flatMap(entry => tree.getLabel(entry.id) ?? []))].sort();
  throw new Error(`${labelled.length ? "ambiguous" : "unknown"} session target ${JSON.stringify(target)}. Labels: ${labels.join(", ") || "(none)"}`);
}

/** Extract into durable project state; the normal --fork path gives the worker its own identity. */
export function forkSessionAt(file: string, target: string, directory: string): string {
  const source = openSessionTree(file);
  const entryId = resolveSessionTarget(source, target);
  if (!source.getBranch(entryId).some(entry => entry.type === "message" && entry.message.role === "assistant")) {
    throw new Error("warm fork needs an assistant entry in the selected path; mark context after reading code");
  }
  mkdirSync(directory, { recursive: true });
  const tree = SessionManager.open(file, directory);
  const branched = tree.createBranchedSession(entryId);
  if (!branched || !existsSync(branched)) throw new Error("Pi did not persist the selected session path");
  return branched;
}

export function navigationLeaf(tree: ReadonlySessionManager, target: string): string | null {
  const entry = tree.getEntry(target);
  return entry?.type === "custom_message" || (entry?.type === "message" && entry.message.role === "user")
    ? entry.parentId : target;
}

/** Ignore old summaries and unrelated appends: only evidence on the requested new branch counts. */
export function rewindEvidence(tree: ReadonlySessionManager, before: readonly SessionEntry[], target: string): string | null {
  const oldIds = new Set(before.map(entry => entry.id));
  const expected = navigationLeaf(tree, target);
  const branch = tree.getBranch();
  const summary = branch.find(entry => !oldIds.has(entry.id) && entry.type === "branch_summary" && entry.parentId === expected);
  if (summary) return summary.id;
  const leaf = tree.getLeafEntry();
  if (leaf && !oldIds.has(leaf.id) && leaf.type === "label" && leaf.label === "rewound" && leaf.parentId === expected) return leaf.id;
  if (tree.getLeafId() === expected && before.at(-1)?.id !== expected) return expected;
  return null;
}
