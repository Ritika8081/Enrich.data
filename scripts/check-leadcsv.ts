import { readFileSync } from "node:fs";
import { parseLeadsCsv } from "../extensions/lead-enrichment/src/profile_finder/bulk_csv.js";

const csvPath = process.argv[2] ?? "extensions/lead-enrichment/lead-cleandata.csv";
const csv = readFileSync(csvPath, "utf8");
const leads = parseLeadsCsv(csv);

console.log(`Total leads parsed: ${leads.length}`);
if (leads.length === 0) {
  console.log("⚠️  No leads found — CSV format may still not be recognized.");
} else {
  console.log("✅ Parsing OK — first 5 leads:");
  for (const lead of leads.slice(0, 5)) {
    console.log(
      `  name="${lead.name}"  phone="${lead.phone ?? "—"}"  email="${lead.email ?? "—"}"`,
    );
  }
  const naCount = leads.filter((l) => !l.email).length;
  console.log(`\n  Leads without email (NA/blank): ${naCount} / ${leads.length}`);
}
