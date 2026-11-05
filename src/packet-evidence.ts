/** Evidence follows inputs, not elapsed time (inspired by eas4ai/sudus). */
export function staleEvidence(packetPaths: readonly string[], basePaths: readonly string[]): string[] {
  const changed = new Set(basePaths);
  return [...new Set(packetPaths)].filter(path => changed.has(path)).sort();
}

/** Decode NUL-delimited git log frames; skip one landing commit, not its ancestors. */
export function basePathsExceptLanding(log: string, landedAs: string | null): string[] {
  const tokens = log.split("\0");
  const paths: string[] = [];
  let skip = true;
  let firstPath = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^[a-f0-9]{40,64}$/.test(token) && tokens[i + 1] === "") {
      skip = token === landedAs;
      firstPath = true;
      i++;
      continue;
    }
    // Git adds one newline before the first path; a filename's own newline remains.
    const path = firstPath ? token.replace(/^\n/, "") : token;
    firstPath = false;
    if (path && !skip) paths.push(path);
  }
  return paths;
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

/** Cut at a UTF-8 boundary so replacement characters cannot exceed the byte budget. */
function byteHead(text: string, budget: number): string {
  const bytes = Buffer.from(text);
  let end = Math.max(0, Math.min(budget, bytes.length));
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function cappedSection(text: string, budget: number, marker: string): string {
  return Buffer.byteLength(text) <= budget ? text : byteHead(text, budget - Buffer.byteLength(marker)) + marker;
}

function diffClass(path: string): number {
  if (/^\.brain\/data\//.test(path) || /\.(?:json|jsonl|lock)$|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|generated|dist|build|coverage|vendor|node_modules)(?:\/|$)/i.test(path)) return 3;
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:go|py))$/i.test(path)) return 1;
  return /^src\//.test(path) || /\.(?:[cm]?[jt]sx?|py|rs|go|c|h|cpp|hpp|cs|java|kt|swift|rb|php|sh|bash|zsh|svelte|vue|ex|exs|erl|hs|scala|sql|lua|r|jl)$/i.test(path) ? 0 : 2;
}

function reviewDiff(diff: string, budget: number): string {
  // Preserve every byte of a file, including its trailing newline. Non-git input is
  // still bounded, but has no file identity to report.
  const files = diff.split(/(?=^diff --git )/m).filter(Boolean).map(text => {
    const header = text.split("\n", 1)[0]!;
    const destination = text.match(/^\+\+\+ (.+)$/m)?.[1];
    const original = text.match(/^--- (.+)$/m)?.[1];
    const raw = (destination === "/dev/null" ? original : destination) ?? header.match(/ ("b\/.*"|b\/.*)$/)?.[1];
    const renamed = text.match(/^rename to (.+)$/m)?.[1];
    const path = (renamed?.replace(/^"|"$/g, "")
      ?? (raw?.startsWith('"') ? raw.slice(3, -1) : raw?.slice(2))) ?? "(unframed diff)";
    let added = 0, removed = 0, inHunk = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) inHunk = true;
      else if (inHunk && line.startsWith("+")) added++;
      else if (inHunk && line.startsWith("-")) removed++;
    }
    return { text, path, added, removed, rank: diffClass(path) };
  }).sort((a, b) => a.rank - b.rank);
  const ordered = files.map(file => file.text).join("");
  if (Buffer.byteLength(ordered) <= budget) return ordered;

  const entries = files.map(file => `- ${JSON.stringify(file.path)}: +${file.added} -${file.removed}\n`);
  const heading = "\n\n## Not shown\n\nOmitted or truncated files (counts cover the full diff):\n";
  // Reserve the tail's inventory before admitting a complete file.
  let tailBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0);
  let shown = "";
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const remainingBytes = tailBytes - Buffer.byteLength(entries[i]!);
    const suffixBytes = i + 1 < files.length ? Buffer.byteLength(heading) + remainingBytes : 0;
    if (Buffer.byteLength(shown) + Buffer.byteLength(file.text) + suffixBytes <= budget) {
      shown += file.text;
      tailBytes = remainingBytes;
      continue;
    }
    const inventory = heading + entries.slice(i).join("");
    const marker = `\n[cut: ${JSON.stringify(file.path)} truncated]\n`;
    if (!shown) shown = byteHead(file.text, budget - Buffer.byteLength(inventory) - Buffer.byteLength(marker)) + marker;
    // An inventory alone can exceed the entire budget for pathological diffs.
    // Keep the hard byte limit and explicitly identify that metadata overflow.
    return cappedSection(shown + inventory, budget, "\n[cut: Not shown inventory exceeds review budget]\n");
  }
  return shown;
}

/** Only explicit report, brief and diff inputs; no session or pane context. */
export function reviewBrief(input: { packet: string; briefPath?: string; brief?: string; report: string; diff: string }): string {
  const text = `# Blind review: ${cappedSection(input.packet, 1024, "[cut]")}

Read only this file and run nothing. The report's checks describe what already ran. Number findings. Answer each question with either observed evidence naming a command, path or line, or "not checked".

1. What did the change touch that no reported check covers?
2. What could still be wrong while every check passes?
3. What was not tested?

${cappedSection(`## Lane brief${input.briefPath ? `: ${input.briefPath}` : ""}\n\n${input.brief ?? "No lane brief recorded."}`, 12 * 1024, "\n[cut: lane brief capped at 12 KiB]\n")}

## Packet report

${cappedSection(input.report, 12 * 1024, "\n[cut: packet report capped at 12 KiB]\n")}

## Packet diff

`;
  return text + reviewDiff(input.diff, 60 * 1024 - Buffer.byteLength(text) - 1) + "\n";
}
