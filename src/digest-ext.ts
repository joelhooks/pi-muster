// Pi TUI pattern: snapshot-lens (plain digest projection).
// No custom terminal component: Pi owns the tool's transcript rendering.
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectDigest } from "./digest.ts";

/** Registration only: no file, socket, subprocess or timer until called. */
export function registerDigest(pi: ExtensionAPI, env: Readonly<NodeJS.ProcessEnv>) {
  pi.registerTool({
    name: "project_digest",
    label: "Muster project digest",
    description: "Read-only one-line project telemetry: PRs, Kodiak, main CI, gate slots, agents and unlanded packets. Sources fail independently as ? with notes. No cadence is started.",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Project dir. Default MUSTER_PROJECT, then cwd." })),
      width: Type.Optional(Type.Integer({ minimum: 40, maximum: 160 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const digest = await projectDigest(resolve(params.project ?? env.MUSTER_PROJECT ?? ctx.cwd), { env, width: params.width });
        return { content: [{ type: "text" as const, text: [digest.line, ...digest.notes].join("\n") }], details: digest };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
      }
    },
  });
}
