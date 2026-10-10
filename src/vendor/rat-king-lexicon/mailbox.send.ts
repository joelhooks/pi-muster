// Compatibility only: pre-Slice-B domain.ts lazily imports Output for an old receipt.
// Read-only schema, no sender or client. Remove after the restart wave.
export { LegacyDeskReceipt as Output } from "../../domain.ts";
