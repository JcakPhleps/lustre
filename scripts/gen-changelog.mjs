#!/usr/bin/env node
/* Regenerate CHANGELOG.md from js/changelog.js (the single source of truth).
   Usage:  node scripts/gen-changelog.mjs                                    */
import { CHANGELOG, VERSION } from "../js/changelog.js";
import { writeFileSync } from "node:fs";

let md = `# Lustre — Changelog\n\nCurrent version: **${VERSION}**\n\n`;
for (const e of CHANGELOG) {
  md += `## ${e.version} — ${e.date}\n`;
  for (const c of e.changes) md += `- ${c}\n`;
  md += "\n";
}
writeFileSync(new URL("../CHANGELOG.md", import.meta.url), md);
console.log(`CHANGELOG.md updated → ${VERSION}`);
