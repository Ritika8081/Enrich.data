/**
 * Smoke test: verifies Hunter lookup is called for a lead with email.
 * Usage: pnpm exec tsx scripts/smoke-enrich-no-email.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLeadsCsv } from "../extensions/lead-enrichment/src/profile_finder/bulk_csv.js";
import { createEnrichLookupFn } from "../extensions/lead-enrichment/src/profile_finder/tool.js";

// ── load config ──────────────────────────────────────────────────────────────
const cfgPath = join(
  process.env.USERPROFILE ?? process.env.HOME ?? "~",
  ".openclaw",
  "openclaw.json",
);
let enrichSoApiKey: string | undefined;
try {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  enrichSoApiKey =
    cfg?.plugins?.entries?.["lead-enrichment"]?.config?.hunterApiKey ?? process.env.HUNTER_API_KEY;
} catch {
  enrichSoApiKey = process.env.HUNTER_API_KEY;
}

if (!enrichSoApiKey) {
  console.error("❌  No hunterApiKey found in config or HUNTER_API_KEY env var.");
  console.error("   Set it with:");
  console.error(
    '   openclaw config set plugins.entries.lead-enrichment.config.hunterApiKey "<KEY>"',
  );
  process.exit(1);
}

// ── pick first lead with email from the CSV ────────────────────────────────
const csvPath = join(import.meta.dirname, "../extensions/lead-enrichment/lead-cleandata.csv");
const leads = parseLeadsCsv(readFileSync(csvPath, "utf8"));
const noEmailLead = leads.find((l) => Boolean(l.email));

if (!noEmailLead) {
  console.log("ℹ️  No leads with email found in the CSV.");
  process.exit(0);
}

console.log(
  `\nTesting with lead: name="${noEmailLead.name}"  email="${noEmailLead.email}" phone="${noEmailLead.phone}"\n`,
);

// ── call hunter ───────────────────────────────────────────────────────────
const lookup = createEnrichLookupFn({ hunterApiKey: enrichSoApiKey });

try {
  const result = await lookup(noEmailLead);
  if (result) {
    console.log("✅  Hunter returned a result:");
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("⚠️  Hunter returned null (person not found, or name/country mismatch).");
    console.log("   This is normal — Hunter may not have this person.");
  }
} catch (err) {
  console.error("❌  Hunter request failed:", err instanceof Error ? err.message : String(err));
}
