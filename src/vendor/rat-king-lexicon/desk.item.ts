// Compatibility only: pre-Slice-B domain.ts lazily imports Main while reading pending state.
// No vendored code, transport or new caller. Remove after the restart wave.
export { DeskRecordItem as Main } from "../../domain.ts";
