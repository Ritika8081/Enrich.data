import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatEnrichedLeadsCsv,
  parseLeadsCsv,
  type BulkLeadOutput,
} from "../extensions/lead-enrichment/src/profile_finder/bulk_csv.js";
import { findProfiles } from "../extensions/lead-enrichment/src/profile_finder/find_profiles.js";
import {
  createEnrichLookupFn,
  createProfileSearchFn,
} from "../extensions/lead-enrichment/src/profile_finder/tool.js";

function parseArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function help(): string {
  return [
    "Bulk lead enrichment from CSV",
    "",
    "Usage:",
    '  node --import tsx scripts/leadfind-bulk.ts --input "C:/path/leads.csv" --output "C:/path/leads_enriched.csv"',
    "",
    "Columns expected: Name,Email,Phone",
    "Email/Phone can be blank.",
  ].join("\n");
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(help());
    return;
  }

  const input = parseArg("--input");
  const output = parseArg("--output");
  if (!input || !output) {
    throw new Error(`Missing --input/--output.\n\n${help()}`);
  }

  const serperApiKey = parseArg("--serper-api-key") ?? process.env.SERPER_API_KEY;
  const tavilyApiKey = parseArg("--tavily-api-key") ?? process.env.TAVILY_API_KEY;
  const hunterApiKey = parseArg("--hunter-api-key") ?? process.env.HUNTER_API_KEY;
  const hunterApiUrl = parseArg("--hunter-api-url") ?? process.env.HUNTER_API_URL;

  if (!serperApiKey || !tavilyApiKey || !hunterApiKey) {
    throw new Error("Set SERPER_API_KEY, TAVILY_API_KEY, and HUNTER_API_KEY first.");
  }

  const csvText = await readFile(path.resolve(input), "utf8");
  const leads = parseLeadsCsv(csvText);
  if (leads.length === 0) {
    throw new Error("No leads found in CSV. Expected columns Name,Email,Phone.");
  }

  const search = createProfileSearchFn({ serperApiKey, tavilyApiKey });
  const enrichLookup = hunterApiKey
    ? createEnrichLookupFn({ hunterApiKey, hunterApiUrl })
    : undefined;

  const rows: BulkLeadOutput[] = [];

  for (let i = 0; i < leads.length; i += 1) {
    const lead = leads[i];
    try {
      const result = await findProfiles(
        {
          name: lead.name,
          ...(lead.email ? { email: lead.email } : {}),
          ...(lead.phone ? { phone: lead.phone } : {}),
        },
        search,
        {
          enrichLookup,
        },
      );

      rows.push({
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        linkedin: result.profiles.linkedin ?? undefined,
        github: result.profiles.github ?? undefined,
        twitter: result.profiles.twitter ?? undefined,
        linkedinCompany: result.linkedinInsights?.company ?? undefined,
        linkedinLocation: result.linkedinInsights?.location ?? undefined,
        experienceYears: result.linkedinInsights?.experienceYears ?? undefined,
        extractedCompany: result.company?.name ?? undefined,
        companyConfidence: result.company?.confidence ?? undefined,
        overallConfidence: Math.round(result.confidence * 100),
      });
      console.log(`[${i + 1}/${leads.length}] OK  ${lead.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rows.push({
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        error: message,
      });
      console.log(`[${i + 1}/${leads.length}] ERR ${lead.name} -> ${message}`);
    }
  }

  const outputPath = path.resolve(output);
  await writeFile(outputPath, formatEnrichedLeadsCsv(rows), "utf8");
  console.log(`\nDone. Wrote ${leads.length} rows to ${outputPath}`);
}

await main();
