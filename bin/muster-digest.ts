#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BadProjectDir, projectDigest } from "../src/digest.ts";
import type { DigestOptions } from "../src/digest.ts";

export async function runDigest(args: readonly string[], options: DigestOptions = {}, output = { line: console.log, error: console.error }): Promise<number> {
  if (args.length !== 1 || !args[0]) {
    output.error("usage: muster-digest <projectDir>");
    return 2;
  }
  try {
    const digest = await projectDigest(resolve(args[0]), options);
    output.line(digest.line);
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return error instanceof BadProjectDir ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runDigest(process.argv.slice(2));
}
