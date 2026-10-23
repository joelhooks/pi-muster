import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { DefaultPackageManager, SettingsManager, loadSkills } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Pi owns discovery: settings skills, packages, defaults and frontmatter. No second filesystem walker, or package
 * skills (pi-effect, pi-ast-grep, ...) go missing. Resolution mirrors DefaultResourceLoader.reload, except a package
 * Pi would install ("onMissing") is skipped: a read-only lookup or a launch must never touch the network or agent dir. */
export async function skillIndex({ cwd, agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent") }: {
  cwd: string; agentDir?: string;
}): Promise<Skill[]> {
  const dir = resolve(expandHome(agentDir));
  const packageManager = new DefaultPackageManager({ cwd, agentDir: dir, settingsManager: SettingsManager.create(cwd, dir) });
  const resolved = await packageManager.resolve(async () => "skip");
  const skillPaths = resolved.skills.filter((resource) => resource.enabled).map((resource) => {
    // The loader maps an auto or package directory to its SKILL.md.
    if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") return resource.path;
    try {
      const file = join(resource.path, "SKILL.md");
      return statSync(resource.path).isDirectory() && existsSync(file) ? file : resource.path;
    } catch { return resource.path; }
  });
  const { skills } = loadSkills({ cwd, agentDir: dir, skillPaths, includeDefaults: false });
  // Every skill stays indexed: findSkills hides disable-model-invocation ones from search, but a launch may still name
  // one explicitly (para-operator, 2026-10-11).
  const seen = new Set<string>();
  return skills.filter((skill) => {
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
  const hidden: string[] = [];
  const seen = new Set<string>();
  for (const entry of skills) {
    const named = isAbsolute(entry) ? undefined : index.find((skill) => skill.name === entry);
    let path = isAbsolute(entry) ? entry : named?.filePath;
    if (path && existsSync(path) && statSync(path).isDirectory()) path = join(path, "SKILL.md");
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      notes.push(`skill ${JSON.stringify(entry)} not found; skipped`);
      continue;
    }
    const real = realpathSync(path);
    if (!seen.has(real)) { seen.add(real); paths.push(real); if (named?.disableModelInvocation) hidden.push(real); }
  }
  return { paths, notes, hidden };
}

/** Pi leaves disable-model-invocation skills out of the model's list even under --skill, and only a typed /skill:
 * expands one. A launch that names one means it, so its SKILL.md joins the appended system prompt, which Pi reads
 * from a file path. */
export function withHiddenSkills(appendSystemPrompt: readonly string[], hidden: readonly string[]): string[] {
  return [...new Set([...appendSystemPrompt, ...hidden])];
}
