// Pi TUI patterns: column-gauge, message-fold.
// Owner mail itself renders through pi-ratking; these are the one-line tool calls and results around it.
import { stripVTControlCharacters } from "node:util";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

export interface OwnerTheme {
  fg(color: "accent" | "error" | "warning" | "success" | "dim" | "toolTitle", text: string): string;
  bold(text: string): string;
  bg?(color: "customMessageBg", text: string): string;
}
// oxlint-disable-next-line no-control-regex -- drops control characters from rendered text
const clean = (s: string) => stripVTControlCharacters(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const oneLine = (s: string) => clean(s).replace(/\s+/g, " ").trim();
/** Collapse at word boundaries on phone terminals; do not cut an emoji or name. */
export function compactWords(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = oneLine(text);
  if (visibleWidth(plain) <= width) return plain;
  let shown = "";
  for (const word of plain.split(/\s+/)) {
    const next = shown ? `${shown} ${word}` : word;
    if (visibleWidth(`${next}…`) > width) break;
    shown = next;
  }
  return `${shown}…`;
}
export function mobileOwnerRow(kind: string, name: string, age: string, width: number): string {
  const tail = ` ${age}`;
  const lead = `${kind} `;
  if (visibleWidth(lead + tail) >= width) return compactWords(kind, width);
  return `${lead}${compactWords(name, width - visibleWidth(lead + tail))}${tail}`;
}
const hideUris = (s: string) => s.replace(/muster:\/\/\S+/g, "[record]");
export function ownerLine(text: string, theme: OwnerTheme): Component {
  return { invalidate() {}, render(width) {
    if (width <= 0) return [];
    const plain = process.env.NO_COLOR !== undefined;
    const summary = hideUris(oneLine(text));
    const shown = width <= 40 ? compactWords(summary, width) : summary;
    const fitted = truncateToWidth(plain ? shown : theme.fg("toolTitle", shown), width);
    return [plain ? clean(fitted) : `${fitted}\x1b[0m`];
  } };
}
export function ownerToolResult(text: string, expanded: boolean, theme: OwnerTheme): Component {
  if (!expanded) return ownerLine(hideUris(text.split("\n")[0] ?? ""), theme);
  return { invalidate() {}, render(width) {
    if (width <= 0) return [];
    if (width <= 40) return ownerLine(text.split("\n")[0] ?? "", theme).render(width);
    const plain = process.env.NO_COLOR !== undefined;
    const body = new Text(plain ? clean(text) : theme.fg("dim", clean(text)), 0, 0);
    return body.render(width).map(line => {
      const fitted = truncateToWidth(line, width);
      return plain ? clean(fitted) : `${fitted}\x1b[0m`;
    });
  } };
}
export function ownerReceipt(input: { kind: string; title: string; path: string; woke: boolean }): string {
  return `🐦 posted ${input.kind} "${oneLine(input.title)}" → @owner · ${input.path === "intercom" ? "legacy fallback" : input.woke ? "woke owner" : "quiet"}`;
}
