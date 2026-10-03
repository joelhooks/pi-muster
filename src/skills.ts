import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { decodeSkillSettings } from "./domain.ts";

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function settingsPaths(base: string): string[] {
  const file = join(base, "settings.json");
  if (!existsSync(file)) return [];
  const settings = decodeSkillSettings(JSON.parse(readFileSync(file, "utf8")));
  return (settings.skills ?? []).map((path) => resolve(base, expandHome(path)));
}

/** Pi owns discovery and frontmatter parsing. No second filesystem walker. */
export function skillIndex({ cwd, agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent") }: {
  cwd: string; agentDir?: string;
}): Skill[] {
  const dir = resolve(expandHome(agentDir));
  const { skills } = loadSkills({
    cwd, agentDir: dir, includeDefaults: true,
    skillPaths: [...settingsPaths(dir), ...settingsPaths(join(cwd, ".pi"))],
  });
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (skill.disableModelInvocation) return false;
    const path = realpathSync(skill.filePath);
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

const STOPWORDS = new Set(["a", "an", "the", "for", "to", "of", "and", "with", "use", "when"]);

function stem(word: string): string {
  const stripped = word.replace(/(ing|ed|s)$/, "");
  const base = stripped.length >= 3 ? stripped : word;
  // Share the silent-e form: writing / write both become writ.
  return base.endsWith("e") && base.length > 3 ? base.slice(0, -1) : base;
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !STOPWORDS.has(word)).map(stem);
}

/** BM25 with corpus IDF, length normalization, weighted names and stable ties. */
export function findSkills({ skills, query, limit = 5 }: { skills: readonly Skill[]; query: string; limit?: number }) {
  const words = new Set(tokens(query));
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(10, Math.floor(limit))) : 5;
  const documents = skills.filter((skill) => !skill.disableModelInvocation).map((skill) => {
    const name = tokens(skill.name);
    const description = tokens(skill.description);
    const frequencies = new Map<string, number>();
    for (const word of name) frequencies.set(word, (frequencies.get(word) ?? 0) + 5);
    for (const word of description) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    return { skill, frequencies, length: name.length + description.length };
  });
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const word of doc.frequencies.keys()) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
  }
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1) || 1;
  const k1 = 1.2;
  const b = 0.75;
  return documents.map(({ skill, frequencies, length }) => {
    let score = skill.name.toLowerCase() === query.trim().toLowerCase() ? 100 : 0;
    for (const word of words) {
      const tf = frequencies.get(word) ?? 0;
      if (!tf) continue;
      const df = documentFrequency.get(word) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / averageLength));
    }
    return { skill, score };
  }).filter(({ score }) => score > 0).sort((a, b) =>
    b.score - a.score || (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0),
  ).slice(0, count).map(({ skill }) => ({
    name: skill.name, description: skill.description.length > 200 ? skill.description.slice(0, 197) + "..." : skill.description,
    path: skill.filePath,
  }));
}

/** Resolve the merged standing and launch skills, preserving order by real path. */
export function resolveSkills({ skills, index }: { skills: readonly string[]; index: readonly Skill[] }) {
  const paths: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const entry of skills) {
    let path = isAbsolute(entry) ? entry : index.find((skill) => skill.name === entry)?.filePath;
    if (path && existsSync(path) && statSync(path).isDirectory()) path = join(path, "SKILL.md");
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      notes.push(`skill ${JSON.stringify(entry)} not found; skipped`);
      continue;
    }
    const real = realpathSync(path);
    if (!seen.has(real)) { seen.add(real); paths.push(real); }
  }
  return { paths, notes };
}
