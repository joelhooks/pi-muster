/** Evidence follows inputs, not elapsed time (inspired by eas4ai/sudus). */
export function staleEvidence(packetPaths: readonly string[], basePaths: readonly string[]): string[] {
  const changed = new Set(basePaths);
  return [...new Set(packetPaths)].filter(path => changed.has(path)).sort();
}

export function evidenceNote(base: string, overlap: readonly string[], gated: boolean): string | null {
  return !gated && overlap.length
    ? `evidence stale: ${base} moved under ${overlap.map(path => JSON.stringify(path)).join(", ")} (${overlap.length} paths) since verify; pass gate or re-run packet_verify`
    : null;
}

export const blindReviewNote = (lines: number, review: string | undefined): string | null =>
  lines > 200 && !review ? "no blind review recorded" : null;

export function changedLines(numstat: string): number {
  return numstat.split("\n").reduce((sum, line) => {
    const [added, removed] = line.split("\t");
    return sum + (Number(added) || 0) + (Number(removed) || 0);
  }, 0);
}

/** Only explicit report, brief and diff inputs; no session or pane context. */
export function reviewBrief(input: { packet: string; briefPath?: string; brief?: string; report: string; diff: string }): string {
  const text = `# Blind review: ${input.packet}

Read only this file and run nothing. The report's checks describe what already ran. Number findings. Answer each question with either observed evidence naming a command, path or line, or "not checked".

1. What did the change touch that no reported check covers?
2. What could still be wrong while every check passes?
3. What was not tested?

## Lane brief${input.briefPath ? `: ${input.briefPath}` : ""}

${input.brief ?? "No lane brief recorded."}

## Packet report

${input.report}

## Packet diff

${input.diff}
`;
  const limit = 60 * 1024;
  const bytes = Buffer.from(text);
  const marker = "\n\n[cut: review brief capped at 60 KiB]\n";
  return bytes.length <= limit ? text : bytes.subarray(0, limit - Buffer.byteLength(marker)).toString("utf8") + marker;
}
