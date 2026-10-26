// A worker's row identity and routing must not leak into fixtures or imported modules.
// Scrub the namespaces, rather than a fixed list, so new launch variables stay isolated too.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MUSTER_") || key.startsWith("RATKING_")) delete process.env[key];
}
