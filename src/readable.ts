export type Readability = { ok: true } | { ok: false; samples: string[] };

/** Technical literals do not contribute to the prose density check. */
function literal(token: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:)/i.test(token)
    || /^(?:\/|~\/|\.\.?\/|[A-Za-z]:[\\/])/.test(token)
    || /^@[^/\s]+\/[^\s]+$/.test(token)
    || /^(?:[a-f\d]{7,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|[\d]+|[0-9A-HJKMNP-TV-Z]{26})$/i.test(token)
    || /^[\p{L}\d]+(?:[-_][\p{L}\d]+)+$/u.test(token)
    || /^(?:src|apps|packages|docs|test|tests|scripts|bin|lib|node_modules)\//.test(token)
    || /^[\w@.+-]+(?:\/[\w@.+-]+)*\.[a-z\d]+$/i.test(token)
    // Ambiguous directory names count as paths, not proof of squashed prose.
    || /^(?!\d+[a-z])[\w@.-]+(?:\/(?!\d+[a-z])[\w@.-]+)+\/?$/i.test(token);
}

/** Mask fenced blocks first, then inline spans with matching backtick run lengths. */
function withoutCode(text: string): string {
  let fence: string | undefined;
  return text.split(/\r?\n/).map(line => {
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    if (fence !== undefined) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return "";
    }
    if (marker) {
      fence = marker[1];
      return "";
    }
    return line;
  }).join("\n").replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ");
}

/** Conservative prose heuristic, not a spelling checker. Code belongs in backticks. */
export function squashed(text: string): Readability {
  const prose = withoutCode(text);
  const tokens = prose.split(/\s+/).map(token => token.replace(/^[([{"']+|[)\]}"',;.!?]+$/g, ""));
  const words = tokens.filter(token => token && !literal(token) && /\p{L}/u.test(token));
  const samples = words.filter(token => token.length >= 24 && (
    /\p{Ll}\p{Lu}/u.test(token)
    || /\p{L}\d+\p{L}/u.test(token)
    || (token.split("/").length >= 3 && token.split("/").some(part => part.length >= 12))
  ));
  // Measure only prose, so a long URL, code block or path can never trip this fallback.
  const field = words.join(" ");
  if (field.length >= 80 && (words.length - 1) / field.length < 0.02 && !samples.length) {
    samples.push(field.slice(0, 160));
  }
  return samples.length ? { ok: false, samples: [...new Set(samples)] } : { ok: true };
}
