import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Remote scripts run these with plain node, which refuses to strip types under node_modules.
// Bellwether ships .ts there, so none of them may reach it through a value import.
const REMOTE_MODULES = ["src/restart-snapshot.ts", "src/session-tree.ts", "src/comms-network.ts"];

function graph(entry: string) {
  const visited = new Set<string>(); const packages = new Set<string>();
  const visit = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && !statement.importClause.name && statement.importClause.namedBindings.elements.every(item => item.isTypeOnly)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (specifier.text.startsWith(".")) visit(resolve(dirname(path), specifier.text));
      else packages.add(specifier.text);
    }
  };
  visit(resolve(entry));
  return packages;
}

describe("modules loaded by remote plain-node scripts", () => {
  it.each(REMOTE_MODULES)("%s has no static value import of Bellwether", entry => {
    expect([...graph(entry)].filter(name => name.includes("bellwether"))).toEqual([]);
  });
});
