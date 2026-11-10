import { readFileSync } from "node:fs";

// Release archives contain this file; source checkouts keep an explicit dev identity.
export const buildInfo: { version: string; commit: string; build: number } = (() => {
  try { return JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8")); }
  catch { return { version: "development", commit: "unknown", build: 0 }; }
})();
