import { describe, expect, it } from "vitest";
import { isTranscriptPath } from "./packet.ts";

describe("transcript paths outrank harness prefixes", () => {
  it.each([
    ".pi-subagents/artifacts/x_transcript.jsonl", ".pi-subagents/artifacts/result.md",
    ".pi/agent/sessions/a/session.jsonl", ".claude/projects/repo/session.jsonl",
    ".codex/sessions/2026/10/session.jsonl", "archive/raw_transcript_backup.jsonl",
    "x/TRANSCRIPT.jsonl", "sessions/session.jsonl", "x/sessions/day/session.jsonl",
    "./.pi-subagents/artifacts/x.json", ".pi\\agent\\sessions\\x.jsonl",
  ])("protects %s", path => expect(isTranscriptPath(path)).toBe(true));
  it.each([
    ".pi/muster/packets/hash/packet.json", ".pi/muster/notes/hash.json",
    ".pi/notes-bridge/events.jsonl", ".claude/work.md", "session.jsonl",
    "x/not-sessions/x.jsonl", "transcript.md", "x_transcript.json", ".wzrrd/output.json",
  ])("leaves non-transcript sidecars unchanged: %s", path => expect(isTranscriptPath(path)).toBe(false));
});
