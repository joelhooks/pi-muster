import { Schema } from "effect";
// Compatibility only: old domain.ts may lazily import this quarantine validator.
// pi-ratking owns quarantine now; refuse rather than let old code persist an envelope.
export const MessageEvent = Schema.Never;
