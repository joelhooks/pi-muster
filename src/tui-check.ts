import { visibleWidth } from "@earendil-works/pi-tui";

/** Text-only port of pi-tui-verify's width, sentinel-style and palette checks.
 * Each line is independent, as if followed by an unstyled sentinel cell. */
export function checkTui(lines: readonly string[], width: number, colors: readonly string[]): string[] {
  const allowed = new Set(colors.map(color => color.toLowerCase()));
  const failures: string[] = [];
  for (const [index, line] of lines.entries()) {
    const at = `line ${index + 1}`;
    if (visibleWidth(line) > width) failures.push(`${at}: width ${visibleWidth(line)} > ${width}`);
    const active = new Set<number>();
    let link = false;
    for (const match of line.matchAll(/\x1b\[([\d;:]*)m|\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      if (match[2] !== undefined) { link = match[2].length > 0; continue; }
      const codes = (match[1] || "0").split(/[;:]/).map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === 0) active.clear();
        else if (code === 38 || code === 48 || code === 58) {
          active.add(code);
          const mode = codes[++i];
          if (mode === 2) {
            // Colon notation may include the optional colour-space id.
            if (match[1]?.includes(":") && codes.length - i >= 5) i++;
            const rgb = codes.slice(i + 1, i + 4);
            const hex = `#${rgb.map(n => n.toString(16).padStart(2, "0")).join("")}`;
            if (!allowed.has(hex)) failures.push(`${at}: colour ${hex} is not a theme token`);
            i += 3;
          } else if (mode === 5) i++;
        } else if (code === 39) active.delete(38);
        else if (code === 49) active.delete(48);
        else if (code === 59) active.delete(58);
        else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) active.add(38);
        else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) active.add(48);
        else if (code === 21) active.add(4);
        else if (code === 22) { active.delete(1); active.delete(2); }
        else if (code === 23) active.delete(3);
        else if (code === 24) active.delete(4);
        else if (code === 25) { active.delete(5); active.delete(6); }
        else if (code === 27) active.delete(7);
        else if (code === 28) active.delete(8);
        else if (code === 29) active.delete(9);
        else if (code === 53) active.add(53);
        else if (code === 54) active.delete(53);
        else if (code >= 1 && code <= 9) active.add(code);
      }
    }
    if (active.size || link) failures.push(`${at}: open style ${[...active].join(",")}${link ? " link" : ""}`);
  }
  return failures;
}
