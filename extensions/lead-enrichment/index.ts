import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolvePreferredOpenClawTmpDir } from "../../src/infra/tmp-openclaw-dir.js";
import {
  formatEnrichedLeadsCsv,
  parseLeadsCsv,
  type BulkLeadOutput,
} from "./src/profile_finder/bulk_csv.js";
import { getDomain } from "./src/profile_finder/company_inference.js";
import { findProfiles } from "./src/profile_finder/find_profiles.js";
import {
  createEnrichLookupFn,
  createFindProfilesTool,
  createPdlLookupFn,
  createProfileSearchFn,
} from "./src/profile_finder/tool.js";

type LeadEnrichmentConfig = {
  serperApiKey?: string;
  tavilyApiKey?: string;
  braveApiKey?: string;
  pdlApiKey?: string;
  pdlApiUrl?: string;
  hunterApiKey?: string;
  hunterApiUrl?: string;
};

type LeadLookupArgs = {
  name: string;
  email?: string;
  phone?: string;
  debug?: boolean;
};

function parseLeadLookupArgs(args: string): LeadLookupArgs | { error: string } {
  const input = args.trim();
  if (!input) {
    return {
      error:
        'Usage: /leadfind --name "Full Name" [--email you@example.com] [--phone 123456789]\n' +
        "   or: /leadfind Full Name | you@example.com | 123456789",
    };
  }

  if (input.includes("|") && !input.includes("--name")) {
    const [rawName, rawEmail, rawPhone] = input.split("|").map((part) => part.trim());
    if (!rawName) {
      return {
        error:
          'Missing name. Usage: /leadfind --name "Full Name" [--email you@example.com] [--phone 123456789]\n' +
          "   or: /leadfind Full Name | you@example.com | 123456789",
      };
    }

    return {
      name: rawName,
      email: rawEmail || undefined,
      phone: rawPhone || undefined,
    };
  }

  const nameMatch = input.match(/--name\s+"([^"]+)"|--name\s+'([^']+)'|--name\s+(\S+)/i);
  const emailMatch = input.match(/--email\s+"([^"]+)"|--email\s+'([^']+)'|--email\s+(\S+)/i);
  const phoneMatch = input.match(/--phone\s+"([^"]+)"|--phone\s+'([^']+)'|--phone\s+(\S+)/i);
  const debugFlag = /--debug\b/i.test(input);

  const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? "").trim();
  const email = (emailMatch?.[1] ?? emailMatch?.[2] ?? emailMatch?.[3] ?? "").trim();
  const phone = (phoneMatch?.[1] ?? phoneMatch?.[2] ?? phoneMatch?.[3] ?? "").trim();

  if (!name) {
    return {
      error:
        'Missing --name. Usage: /leadfind --name "Full Name" [--email you@example.com] [--phone 123456789]\n' +
        "   or: /leadfind Full Name | you@example.com | 123456789",
    };
  }

  return {
    name,
    email: email || undefined,
    phone: phone || undefined,
    debug: debugFlag,
  };
}

function getAttachmentCandidates(ctx: {
  mediaPath?: string;
  mediaPaths?: string[];
  mediaType?: string;
  mediaTypes?: string[];
}): Array<{ filePath: string; mediaType?: string }> {
  const paths = [ctx.mediaPath, ...(ctx.mediaPaths ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  const types = [ctx.mediaType, ...(ctx.mediaTypes ?? [])].map((value) =>
    typeof value === "string" ? value.toLowerCase() : undefined,
  );

  return paths.map((filePath, index) => ({
    filePath,
    mediaType: types[index],
  }));
}

function isCsvAttachment(filePath: string, mediaType?: string): boolean {
  const lowerPath = filePath.toLowerCase();
  const lowerType = (mediaType ?? "").toLowerCase();
  return lowerPath.endsWith(".csv") || lowerType.includes("text/csv") || lowerType.includes("csv");
}

function isExcelAttachment(filePath: string, mediaType?: string): boolean {
  const lowerPath = filePath.toLowerCase();
  const lowerType = (mediaType ?? "").toLowerCase();
  return (
    lowerPath.endsWith(".xlsx") ||
    lowerPath.endsWith(".xls") ||
    lowerType.includes("spreadsheetml") ||
    lowerType.includes("application/vnd.ms-excel")
  );
}

function isTextLikeAttachment(mediaType?: string): boolean {
  const lowerType = (mediaType ?? "").toLowerCase();
  return (
    lowerType.includes("text/plain") ||
    lowerType.includes("text/csv") ||
    lowerType.includes("application/csv") ||
    lowerType.includes("application/vnd.ms-excel") ||
    lowerType.includes("text/")
  );
}

function isLikelyCsvText(input: string): boolean {
  const previewLines = input
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
  return previewLines.some((line) => line.includes(","));
}

async function resolveCsvAttachment(
  attachments: Array<{ filePath: string; mediaType?: string }>,
): Promise<{ filePath: string; leads: ReturnType<typeof parseLeadsCsv> } | null> {
  for (const attachment of attachments) {
    if (!isCsvAttachment(attachment.filePath, attachment.mediaType)) continue;
    const csvInput = await readFile(attachment.filePath, "utf8");
    const leads = parseLeadsCsv(csvInput);
    if (leads.length > 0) {
      return { filePath: attachment.filePath, leads };
    }
  }

  for (const attachment of attachments) {
    if (
      !isTextLikeAttachment(attachment.mediaType) &&
      !/\.(txt|tsv|text)$/i.test(attachment.filePath)
    ) {
      continue;
    }

    try {
      const maybeCsvInput = await readFile(attachment.filePath, "utf8");
      if (!isLikelyCsvText(maybeCsvInput)) continue;
      const leads = parseLeadsCsv(maybeCsvInput);
      if (leads.length > 0) {
        return { filePath: attachment.filePath, leads };
      }
    } catch {
      // Ignore non-text attachments that cannot be read as UTF-8.
    }
  }

  return null;
}

function resolveInlineCsvLeads(args: string): ReturnType<typeof parseLeadsCsv> | null {
  const input = args.trim();
  if (!input) return null;
  if (/--name\b|--email\b|--phone\b/i.test(input)) return null;
  if (!isLikelyCsvText(input)) return null;

  const leads = parseLeadsCsv(input);
  return leads.length > 0 ? leads : null;
}

function formatBulkErrorSummary(errorCounts: Map<string, number>): string | undefined {
  if (errorCounts.size === 0) return undefined;

  const topErrors = [...errorCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([message, count]) => {
      const compact = message.replace(/\s+/g, " ").trim();
      const capped = compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
      return `${count}× ${capped}`;
    });

  return topErrors.length > 0 ? `Top errors: ${topErrors.join(" | ")}` : undefined;
}

function collectBulkErrorCounts(rows: BulkLeadOutput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.error) continue;
    const message = row.error.trim();
    if (!message) continue;
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  return counts;
}

function isSearchProviderOutageError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all search providers failed") ||
    normalized.includes("serper search error") ||
    normalized.includes("tavily search error")
  );
}

function summarizeExternalError(message: string, maxLength = 120): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();

  if (lower.includes("not enough credits")) {
    return "not enough credits";
  }
  if (lower.includes("exceeds your plan") || lower.includes("usage limit")) {
    return "plan usage limit exceeded";
  }
  if (
    lower.includes("invalid api key") ||
    lower.includes("authentication_error") ||
    lower.includes("401 unauthorized")
  ) {
    return "invalid API key";
  }
  if (lower.includes("invalid_email") || lower.includes("belongs to a webmail")) {
    return "webmail email unsupported";
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "rate limited";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "request timed out";
  }

  const withoutJsonTail = compact.replace(/\s*\|\s*\{[\s\S]*$/, "").trim();
  const finalText = withoutJsonTail || compact;
  return finalText.length > maxLength ? `${finalText.slice(0, maxLength - 3)}...` : finalText;
}

function summarizeSearchProviderFailure(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const serperMatch = compact.match(/serper:\s*(.*?)(?=\s+\|\s+tavily:|\)$)/i);
  const tavilyMatch = compact.match(/tavily:\s*(.*?)(?=\)$)/i);

  const segments: string[] = [];
  if (serperMatch?.[1]) {
    segments.push(`serper: ${summarizeExternalError(serperMatch[1], 90)}`);
  }
  if (tavilyMatch?.[1]) {
    segments.push(`tavily: ${summarizeExternalError(tavilyMatch[1], 90)}`);
  }

  if (segments.length > 0) {
    return segments.join(" | ");
  }

  return summarizeExternalError(compact, 180);
}

function buildManualProfileLookupLinks(input: { name: string; email?: string; phone?: string }): {
  linkedin: string;
  github: string;
  twitter: string;
} {
  const name = input.name.trim();
  const terms = [name, input.email, input.phone].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const query = encodeURIComponent(terms.join(" "));

  return {
    linkedin: `https://www.google.com/search?q=${query}+site%3Alinkedin.com%2Fin`,
    github: `https://www.google.com/search?q=${query}+site%3Agithub.com`,
    twitter: `https://www.google.com/search?q=${query}+(site%3Atwitter.com+OR+site%3Ax.com)`,
  };
}

function maskApiKey(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return "missing";
  if (trimmed.length <= 8) return "configured";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function summarizeProviderAttribution(params: {
  serperApiKey?: string;
  tavilyApiKey?: string;
  pdlApiKey?: string;
  pdlUsed: boolean;
  pdlContributed: boolean;
  hunterApiKey?: string;
  serperResults: number;
  tavilyResults: number;
  hunterUsed: boolean;
  hunterContributed: boolean;
}): string {
  return [
    `serper[key=${maskApiKey(params.serperApiKey)}, results=${params.serperResults}]`,
    `tavily[key=${maskApiKey(params.tavilyApiKey)}, results=${params.tavilyResults}]`,
    `pdl[key=${maskApiKey(params.pdlApiKey)}, used=${params.pdlUsed ? "yes" : "no"}, contributed=${params.pdlContributed ? "yes" : "no"}]`,
    `hunter[key=${maskApiKey(params.hunterApiKey)}, used=${params.hunterUsed ? "yes" : "no"}, contributed=${params.hunterContributed ? "yes" : "no"}]`,
  ].join(" | ");
}

function createConfigSchema() {
  return {
    safeParse(value: unknown) {
      if (value === undefined || value === null) {
        return { success: true, data: {} };
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "config must be an object" }] },
        };
      }
      const config = value as Record<string, unknown>;
      if (config.serperApiKey !== undefined && typeof config.serperApiKey !== "string") {
        return {
          success: false,
          error: { issues: [{ path: ["serperApiKey"], message: "serperApiKey must be a string" }] },
        };
      }
      if (config.tavilyApiKey !== undefined && typeof config.tavilyApiKey !== "string") {
        return {
          success: false,
          error: { issues: [{ path: ["tavilyApiKey"], message: "tavilyApiKey must be a string" }] },
        };
      }
      if (config.braveApiKey !== undefined && typeof config.braveApiKey !== "string") {
        return {
          success: false,
          error: { issues: [{ path: ["braveApiKey"], message: "braveApiKey must be a string" }] },
        };
      }
      if (config.pdlApiKey !== undefined && typeof config.pdlApiKey !== "string") {
        return {
          success: false,
          error: { issues: [{ path: ["pdlApiKey"], message: "pdlApiKey must be a string" }] },
        };
      }
      if (config.pdlApiUrl !== undefined && typeof config.pdlApiUrl !== "string") {
        return {
          success: false,
          error: { issues: [{ path: ["pdlApiUrl"], message: "pdlApiUrl must be a string" }] },
        };
      }
      if (config.hunterApiKey !== undefined && typeof config.hunterApiKey !== "string") {
        return {
          success: false,
          error: {
            issues: [{ path: ["hunterApiKey"], message: "hunterApiKey must be a string" }],
          },
        };
      }
      if (config.hunterApiUrl !== undefined && typeof config.hunterApiUrl !== "string") {
        return {
          success: false,
          error: {
            issues: [{ path: ["hunterApiUrl"], message: "hunterApiUrl must be a string" }],
          },
        };
      }
      return { success: true, data: config };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        serperApiKey: {
          type: "string",
          description: "Serper API key for profile discovery queries.",
        },
        tavilyApiKey: {
          type: "string",
          description: "Tavily API key for profile discovery queries.",
        },
        braveApiKey: {
          type: "string",
          description:
            "Deprecated fallback: Brave Search API token. Prefer serperApiKey or SERPER_API_KEY.",
        },
        pdlApiKey: {
          type: "string",
          description:
            "People Data Labs API key used for primary person enrichment before search corroboration.",
        },
        pdlApiUrl: {
          type: "string",
          description:
            "Optional People Data Labs endpoint override. Defaults to https://api.peopledatalabs.com/v5/person/enrich.",
        },
        hunterApiKey: {
          type: "string",
          description: "Hunter API key used for people enrichment lookup on each run.",
        },
        hunterApiUrl: {
          type: "string",
          description:
            "Optional Hunter endpoint override. Defaults to https://api.hunter.io/v2/people/find.",
        },
      },
    },
  };
}

const plugin = {
  id: "lead-enrichment",
  name: "Lead Enrichment",
  description: "Social profile discovery (LinkedIn, GitHub, Twitter) from name, email, or phone.",
  configSchema: createConfigSchema(),
  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as LeadEnrichmentConfig;
    const serperApiKey =
      config.serperApiKey ??
      process.env.SERPER_API_KEY ??
      config.braveApiKey ??
      process.env.BRAVE_API_KEY;
    const tavilyApiKey = config.tavilyApiKey ?? process.env.TAVILY_API_KEY;
    const pdlApiKey = config.pdlApiKey ?? process.env.PDL_API_KEY;
    const pdlApiUrl = config.pdlApiUrl ?? process.env.PDL_API_URL;
    const hunterApiKey = config.hunterApiKey ?? process.env.HUNTER_API_KEY;
    const hunterApiUrl = config.hunterApiUrl ?? process.env.HUNTER_API_URL;
    const pdlLookup = pdlApiKey ? createPdlLookupFn({ pdlApiKey, pdlApiUrl }) : undefined;
    const enrichLookup = hunterApiKey
      ? createEnrichLookupFn({ hunterApiKey, hunterApiUrl })
      : undefined;
    const hasAllProviders = Boolean(serperApiKey && tavilyApiKey);

    api.registerCommand({
      name: "leadfind",
      description:
        "Find public LinkedIn/GitHub/Twitter profiles for a lead or enrich attached CSV.",
      acceptsArgs: true,
      handler: async (ctx) => {
        console.log("\n=== TELEGRAM REQUEST - API KEYS BEING USED ===");
        console.log("Serper API Key:", serperApiKey ?? "(missing)");
        console.log("Tavily API Key:", tavilyApiKey ?? "(missing)");
        console.log("PDL API Key:", pdlApiKey ?? "(missing)");
        console.log("Hunter API Key:", hunterApiKey ?? "(missing)");
        console.log("Key sources:");
        console.log("  Serper:", config.serperApiKey ? "plugin-config" : process.env.SERPER_API_KEY ? "env" : "missing");
        console.log("  Tavily:", config.tavilyApiKey ? "plugin-config" : process.env.TAVILY_API_KEY ? "env" : "missing");
        console.log("  PDL:", config.pdlApiKey ? "plugin-config" : process.env.PDL_API_KEY ? "env" : "missing");
        console.log("  Hunter:", config.hunterApiKey ? "plugin-config" : process.env.HUNTER_API_KEY ? "env" : "missing");
        console.log("================================================\n");

        if (!hasAllProviders) {
          return {
            text:
              "Lead enrichment is not configured. Missing required API key(s).\n\n" +
              "Set it with:\n" +
              'openclaw config set plugins.entries.lead-enrichment.config.serperApiKey "<YOUR_KEY>"\n' +
              'openclaw config set plugins.entries.lead-enrichment.config.tavilyApiKey "<YOUR_KEY>"\n' +
              'openclaw config set plugins.entries.lead-enrichment.config.pdlApiKey "<YOUR_KEY>"\n' +
              "Optional fallback:\n" +
              'openclaw config set plugins.entries.lead-enrichment.config.hunterApiKey "<YOUR_KEY>"\n' +
              "or set SERPER_API_KEY / TAVILY_API_KEY / PDL_API_KEY / HUNTER_API_KEY in your environment.",
          };
        }

        const search = createProfileSearchFn({ serperApiKey, tavilyApiKey });
        const attachments = getAttachmentCandidates(ctx);
        const csvAttachment = await resolveCsvAttachment(attachments);
        const inlineCsvLeads = !csvAttachment ? resolveInlineCsvLeads(ctx.args ?? "") : null;
        const excelAttachment = attachments.find((attachment) =>
          isExcelAttachment(attachment.filePath, attachment.mediaType),
        );

        if (csvAttachment || inlineCsvLeads) {
          try {
            const leads = csvAttachment?.leads ?? inlineCsvLeads ?? [];
            if (leads.length === 0) {
              return {
                text: "CSV received, but no valid rows were found. Expected columns: Name,Email,Phone.",
              };
            }

            const rows: BulkLeadOutput[] = [];
            const errorCounts = new Map<string, number>();
            for (const lead of leads) {
              try {
                const result = await findProfiles(
                  {
                    name: lead.name,
                    ...(lead.email ? { email: lead.email } : {}),
                    ...(lead.phone ? { phone: lead.phone } : {}),
                  },
                  search,
                  {
                    pdlLookup,
                    enrichLookup,
                  },
                );

                const linkedinPossibilities = [
                  ...new Set(
                    [
                      result.profiles.linkedin,
                      ...result.strongCandidates
                        .filter((candidate) => candidate.platform === "linkedin")
                        .map((candidate) => candidate.url),
                      ...result.candidateProfiles
                        .filter((candidate) => candidate.platform === "linkedin")
                        .map((candidate) => candidate.url),
                    ].filter((value): value is string => Boolean(value)),
                  ),
                ].slice(0, 3);

                const linkedinOutput = linkedinPossibilities[0];
                const hasOnlySuggestedLinkedin = Boolean(
                  !result.profiles.linkedin && linkedinOutput,
                );
                const suggestionNote = hasOnlySuggestedLinkedin
                  ? "Suggested LinkedIn candidate; verify manually"
                  : undefined;
                const linkedinSource = hasOnlySuggestedLinkedin
                  ? "candidate-search"
                  : result.resultOrigins.linkedin;

                rows.push({
                  name: lead.name,
                  email: lead.email,
                  phone: lead.phone,
                  linkedin: linkedinOutput ?? undefined,
                  linkedinOption1: linkedinPossibilities[0],
                  linkedinOption2: linkedinPossibilities[1],
                  linkedinOption3: linkedinPossibilities[2],
                  github: result.profiles.github ?? undefined,
                  twitter: result.profiles.twitter ?? undefined,
                  linkedinCompany: result.linkedinInsights?.company ?? undefined,
                  linkedinLocation: result.linkedinInsights?.location ?? undefined,
                  experienceYears: result.linkedinInsights?.experienceYears ?? undefined,
                  extractedCompany: result.company?.name ?? undefined,
                  linkedinSource,
                  githubSource: result.resultOrigins.github,
                  twitterSource: result.resultOrigins.twitter,
                  companySource: result.resultOrigins.company,
                  companyConfidence: result.company?.confidence ?? undefined,
                  overallConfidence: Math.round(result.confidence * 100),
                  resultSource: summarizeProviderAttribution({
                    serperApiKey,
                    tavilyApiKey,
                    pdlApiKey,
                    pdlUsed: result.providerSignals.pdlUsed,
                    pdlContributed: result.providerSignals.pdlContributed,
                    hunterApiKey,
                    serperResults: result.providerSignals.serperResults,
                    tavilyResults: result.providerSignals.tavilyResults,
                    hunterUsed: result.providerSignals.hunterUsed,
                    hunterContributed: result.providerSignals.hunterContributed,
                  }),
                  note: suggestionNote,
                  error: suggestionNote
                    ? undefined
                    : !result.profiles.linkedin &&
                        !result.profiles.github &&
                        !result.profiles.twitter &&
                        !result.company?.name &&
                        result.confidence <= 0
                      ? "No confident profile match found"
                      : undefined,
                });
              } catch (error) {
                const primaryError = error instanceof Error ? error.message : String(error);
                let pdlFallbackUsed = false;
                let hunterFallbackUsed = false;
                let pdlFallbackContributed = false;
                let hunterFallbackContributed = false;

                if (pdlLookup || enrichLookup) {
                  try {
                    let enrich = null;

                    if (pdlLookup) {
                      pdlFallbackUsed = true;
                      try {
                        enrich = await pdlLookup({
                          name: lead.name,
                          ...(lead.email ? { email: lead.email } : {}),
                          ...(lead.phone ? { phone: lead.phone } : {}),
                        });
                        if (enrich) {
                          pdlFallbackContributed = true;
                        }
                      } catch {
                        enrich = null;
                      }
                    }

                    if (!enrich && enrichLookup) {
                      hunterFallbackUsed = true;
                      try {
                        enrich = await enrichLookup({
                          name: lead.name,
                          ...(lead.email ? { email: lead.email } : {}),
                          ...(lead.phone ? { phone: lead.phone } : {}),
                        });
                        if (enrich) {
                          hunterFallbackContributed = true;
                        }
                      } catch {
                        enrich = null;
                      }
                    }

                    const hasEnrichData = Boolean(
                      enrich?.linkedin ||
                      enrich?.github ||
                      enrich?.twitter ||
                      enrich?.company?.name ||
                      enrich?.linkedinInsights?.company ||
                      enrich?.linkedinInsights?.location ||
                      enrich?.linkedinInsights?.experienceYears != null,
                    );

                    if (enrich && hasEnrichData) {
                      rows.push({
                        name: lead.name,
                        email: lead.email,
                        phone: lead.phone,
                        linkedin: enrich.linkedin ?? undefined,
                        github: enrich.github ?? undefined,
                        twitter: enrich.twitter ?? undefined,
                        linkedinCompany: enrich.linkedinInsights?.company ?? undefined,
                        linkedinLocation: enrich.linkedinInsights?.location ?? undefined,
                        experienceYears: enrich.linkedinInsights?.experienceYears ?? undefined,
                        extractedCompany: enrich.company?.name ?? undefined,
                        linkedinSource: pdlFallbackContributed
                          ? "pdl"
                          : hunterFallbackContributed
                            ? "hunter"
                            : undefined,
                        githubSource: pdlFallbackContributed
                          ? "pdl"
                          : hunterFallbackContributed
                            ? "hunter"
                            : undefined,
                        twitterSource: pdlFallbackContributed
                          ? "pdl"
                          : hunterFallbackContributed
                            ? "hunter"
                            : undefined,
                        companySource: pdlFallbackContributed
                          ? "pdl"
                          : hunterFallbackContributed
                            ? "hunter"
                            : undefined,
                        companyConfidence:
                          typeof enrich.company?.confidence === "number"
                            ? Math.round(enrich.company.confidence)
                            : undefined,
                        overallConfidence: 40,
                        resultSource: summarizeProviderAttribution({
                          serperApiKey,
                          tavilyApiKey,
                          pdlApiKey,
                          pdlUsed: pdlFallbackUsed,
                          pdlContributed: pdlFallbackContributed,
                          hunterApiKey,
                          serperResults: 0,
                          tavilyResults: 0,
                          hunterUsed: hunterFallbackUsed,
                          hunterContributed: hunterFallbackContributed,
                        }),
                      });
                      continue;
                    }
                  } catch {
                    // Ignore fallback errors and keep the original provider error below.
                  }
                }

                errorCounts.set(primaryError, (errorCounts.get(primaryError) ?? 0) + 1);
                rows.push({
                  name: lead.name,
                  email: lead.email,
                  phone: lead.phone,
                  resultSource: summarizeProviderAttribution({
                    serperApiKey,
                    tavilyApiKey,
                    pdlApiKey,
                    pdlUsed: pdlFallbackUsed,
                    pdlContributed: false,
                    hunterApiKey,
                    serperResults: 0,
                    tavilyResults: 0,
                    hunterUsed: hunterFallbackUsed,
                    hunterContributed: false,
                  }),
                  error: primaryError,
                });
              }
            }

            let outputPath: string;
            if (csvAttachment) {
              const inputBase =
                path.basename(csvAttachment.filePath).replace(/\.[^.]+$/, "") || "leads";
              outputPath = path.join(
                path.dirname(csvAttachment.filePath),
                `${inputBase}_enriched.csv`,
              );
            } else {
              const fallbackDir = path.join(resolvePreferredOpenClawTmpDir(), "lead-enrichment");
              await mkdir(fallbackDir, { recursive: true });
              outputPath = path.join(fallbackDir, `inline_leads_${Date.now()}_enriched.csv`);
            }

            await writeFile(outputPath, formatEnrichedLeadsCsv(rows), "utf8");

            const successCount = rows.filter((row) => !row.error).length;
            const failedCount = rows.length - successCount;
            const errorSummary = formatBulkErrorSummary(
              errorCounts.size > 0 ? errorCounts : collectBulkErrorCounts(rows),
            );

            return {
              text:
                `Bulk lead enrichment complete. Rows=${rows.length}, success=${successCount}, failed=${failedCount}. ` +
                "Returning enriched CSV file." +
                (errorSummary ? `\n${errorSummary}` : "") +
                (failedCount > 0 ? "\nSee CSV 'Error' column for row-level failure reasons." : ""),
              mediaUrl: outputPath,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            return {
              text: `CSV bulk enrichment failed: ${message}`,
            };
          }
        }

        if (excelAttachment && !(ctx.args ?? "").trim()) {
          return {
            text:
              "Excel attachment received. XLSX/XLS parsing is not enabled yet in /leadfind. " +
              "Please export to CSV (Name,Email,Phone) and re-send the CSV file.",
          };
        }

        const parsed = parseLeadLookupArgs(ctx.args ?? "");
        if ("error" in parsed) {
          if (attachments.length > 0) {
            return {
              text:
                `${parsed.error}\n\n` +
                "Tip: attach a CSV file with columns Name,Email,Phone to run bulk enrichment.",
            };
          }
          return {
            text:
              `${parsed.error}\n\n` +
              "Tip: you can also paste CSV rows directly after /leadfind using columns Name,Email,Phone.",
          };
        }

        try {
          const result = await findProfiles(parsed, search, {
            debug: parsed.debug,
            pdlLookup,
            enrichLookup,
          });

          const lines: string[] = [];
          lines.push("**Profile Lookup Results**");
          lines.push(`Name: ${parsed.name}`);
          if (parsed.email) lines.push(`Email: ${parsed.email}`);
          if (parsed.phone) lines.push(`Phone: ${parsed.phone}`);

          const resolveProfileDisplay = (platform: "linkedin" | "github" | "twitter") => {
            const accepted = result.profiles[platform];
            if (accepted) return accepted;

            const topCandidate = result.candidateProfiles
              .filter((candidate) => candidate.platform === platform)
              .sort((left, right) => right.confidence - left.confidence)[0];

            if (topCandidate && topCandidate.confidence >= 0.3) {
              return `${topCandidate.url} (candidate ${Math.round(topCandidate.confidence * 100)}%)`;
            }

            return "not found";
          };

          lines.push("");
          lines.push(`LinkedIn: ${resolveProfileDisplay("linkedin")}`);
          lines.push(`GitHub:   ${resolveProfileDisplay("github")}`);
          lines.push(`Twitter:  ${resolveProfileDisplay("twitter")}`);
          if (result.linkedinInsights) {
            const details: string[] = [];
            if (result.linkedinInsights.company) {
              details.push(`company=${result.linkedinInsights.company}`);
            }
            if (result.linkedinInsights.location) {
              details.push(`location=${result.linkedinInsights.location}`);
            }
            if (result.linkedinInsights.experienceYears != null) {
              details.push(`experience=${result.linkedinInsights.experienceYears} years`);
            }
            details.push(`source=${result.linkedinInsights.sourceTier}`);
            if (details.length > 0) {
              lines.push(`LinkedIn details: ${details.join(", ")}`);
            }
          }
          lines.push(
            `Extracted Company: ${result.company ? `${result.company.name} (${result.company.confidence}%)` : "not found"}`,
          );
          lines.push(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
          lines.push(
            `Confidence by platform: linkedin=${Math.round(result.confidenceByPlatform.linkedin * 100)}% ` +
              `github=${Math.round(result.confidenceByPlatform.github * 100)}% ` +
              `twitter=${Math.round(result.confidenceByPlatform.twitter * 100)}%`,
          );
          lines.push(
            `Provider Attribution: ${summarizeProviderAttribution({
              serperApiKey,
              tavilyApiKey,
              pdlApiKey,
              pdlUsed: result.providerSignals.pdlUsed,
              pdlContributed: result.providerSignals.pdlContributed,
              hunterApiKey,
              serperResults: result.providerSignals.serperResults,
              tavilyResults: result.providerSignals.tavilyResults,
              hunterUsed: result.providerSignals.hunterUsed,
              hunterContributed: result.providerSignals.hunterContributed,
            })}`,
          );
          lines.push(
            `Result origins: linkedin=${result.resultOrigins.linkedin}, github=${result.resultOrigins.github}, ` +
              `twitter=${result.resultOrigins.twitter}, company=${result.resultOrigins.company}`,
          );

          if (result.company) {
            lines.push("");
            const co = result.company;
            const sourceSummary = [...new Set(co.sources.map((s) => s.source ?? s.type))].join(
              ", ",
            );
            lines.push(
              `Company: ${co.name} [${co.confidence}%]${sourceSummary ? ` (via ${sourceSummary})` : ""}`,
            );
            if (co.domain) lines.push(`  Domain: ${co.domain}`);
          }

          if (result.acceptedProfiles.length > 0) {
            lines.push("");
            lines.push("Accepted profiles:");
            for (const accepted of result.acceptedProfiles) {
              lines.push(
                `- ${accepted.platform}: ${accepted.url} (${Math.round(accepted.confidence * 100)}%)`,
              );
            }
          }

          if (result.candidateProfiles.length > 0) {
            lines.push("");
            lines.push("Candidate profiles:");
            for (const candidate of result.candidateProfiles) {
              lines.push(
                `- ${candidate.platform}: ${candidate.url} (${Math.round(candidate.confidence * 100)}%)`,
              );
              if (candidate.evidence.length > 0) {
                lines.push(`  evidence: ${candidate.evidence.join(", ")}`);
              }
            }
          }

          if (result.strongCandidates.length > 0) {
            const platforms: Array<"linkedin" | "github" | "twitter"> = [
              "linkedin",
              "github",
              "twitter",
            ];
            lines.push("");
            lines.push("Strong candidates (top 5 per platform):");
            for (const platform of platforms) {
              const platformCandidates = result.strongCandidates
                .filter((candidate) => candidate.platform === platform)
                .slice(0, 5);
              if (platformCandidates.length === 0) continue;
              lines.push(`- ${platform}:`);
              for (const candidate of platformCandidates) {
                lines.push(
                  `  - ${candidate.url} (score=${candidate.score}, corroborated=${candidate.corroborated ? "yes" : "no"})`,
                );
                if (candidate.evidence.length > 0) {
                  lines.push(`    evidence: ${candidate.evidence.join(", ")}`);
                }
              }
            }
          }

          return { text: lines.join("\n") };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";

          if ((pdlLookup || enrichLookup) && isSearchProviderOutageError(message)) {
            const fallbackStatusParts: string[] = [];
            try {
              let enrich = null;
              let enrichSource: "pdl" | "hunter" | null = null;

              if (pdlLookup) {
                try {
                  const pdlResult = await pdlLookup(parsed);
                  if (pdlResult) {
                    enrich = pdlResult;
                    enrichSource = "pdl";
                    fallbackStatusParts.push("People Data Labs lookup succeeded.");
                  } else {
                    fallbackStatusParts.push("People Data Labs lookup returned no usable profile match.");
                  }
                } catch (pdlError) {
                  const pdlErrorMessage =
                    pdlError instanceof Error
                      ? summarizeExternalError(pdlError.message)
                      : "unknown People Data Labs error";
                  fallbackStatusParts.push(`People Data Labs lookup failed: ${pdlErrorMessage}`);
                }
              }

              if (!enrich && enrichLookup) {
                const skipHunterForWebmail = Boolean(parsed.email && !getDomain(parsed.email));
                if (skipHunterForWebmail) {
                  fallbackStatusParts.push(
                    "Hunter lookup skipped: webmail emails are unsupported by Hunter.",
                  );
                } else {
                  try {
                    const hunterResult = await enrichLookup(parsed);
                    if (hunterResult) {
                      enrich = hunterResult;
                      enrichSource = "hunter";
                      fallbackStatusParts.push("Hunter lookup succeeded.");
                    } else {
                      fallbackStatusParts.push("Hunter lookup returned no usable profile match.");
                    }
                  } catch (hunterError) {
                    const hunterErrorMessage =
                      hunterError instanceof Error
                        ? summarizeExternalError(hunterError.message)
                        : "unknown Hunter lookup error";
                    fallbackStatusParts.push(`Hunter lookup failed: ${hunterErrorMessage}`);
                  }
                }
              }

              const hasEnrichData = Boolean(
                enrich?.linkedin ||
                enrich?.github ||
                enrich?.twitter ||
                enrich?.company?.name ||
                enrich?.linkedinInsights?.company ||
                enrich?.linkedinInsights?.location ||
                enrich?.linkedinInsights?.experienceYears != null,
              );

              if (hasEnrichData) {
                const lines: string[] = [];
                lines.push("**Profile Lookup Results (API fallback)**");
                lines.push(`Name: ${parsed.name}`);
                if (parsed.email) lines.push(`Email: ${parsed.email}`);
                if (parsed.phone) lines.push(`Phone: ${parsed.phone}`);
                lines.push("");
                lines.push(`LinkedIn: ${enrich?.linkedin ?? "not found"}`);
                lines.push(`GitHub:   ${enrich?.github ?? "not found"}`);
                lines.push(`Twitter:  ${enrich?.twitter ?? "not found"}`);
                if (enrich?.linkedinInsights) {
                  const details: string[] = [];
                  if (enrich.linkedinInsights.company) {
                    details.push(`company=${enrich.linkedinInsights.company}`);
                  }
                  if (enrich.linkedinInsights.location) {
                    details.push(`location=${enrich.linkedinInsights.location}`);
                  }
                  if (enrich.linkedinInsights.experienceYears != null) {
                    details.push(`experience=${enrich.linkedinInsights.experienceYears} years`);
                  }
                  if (details.length > 0) {
                    lines.push(`LinkedIn details: ${details.join(", ")}`);
                  }
                }
                if (enrich?.company?.name) {
                  const confidence =
                    typeof enrich.company.confidence === "number"
                      ? `${Math.round(enrich.company.confidence)}%`
                      : "n/a";
                  lines.push(
                    `Extracted Company: ${enrich.company.name}${enrich.company.domain ? ` (${enrich.company.domain})` : ""} [${confidence}]`,
                  );
                } else {
                  lines.push("Extracted Company: not found");
                }
                lines.push("");
                lines.push(
                  "Search providers are currently failing. This response used API enrichment fallback.",
                );
                if (enrichSource === "pdl") {
                  lines.push("Fallback source: People Data Labs");
                } else if (enrichSource === "hunter") {
                  lines.push("Fallback source: Hunter");
                }
                return { text: lines.join("\n") };
              }

              if (fallbackStatusParts.length === 0) {
                fallbackStatusParts.push("API enrichment fallback returned no usable profile match.");
              }
            } catch {
              if (fallbackStatusParts.length === 0) {
                fallbackStatusParts.push("API enrichment fallback failed unexpectedly.");
              }
            }

            const enrichFallbackStatus = fallbackStatusParts.join(" | ");

            const links = buildManualProfileLookupLinks(parsed);
            const searchFailureSummary = summarizeSearchProviderFailure(message);
            const lines: string[] = [];
            lines.push("**Profile Lookup Results (manual fallback)**");
            lines.push(`Name: ${parsed.name}`);
            if (parsed.email) lines.push(`Email: ${parsed.email}`);
            if (parsed.phone) lines.push(`Phone: ${parsed.phone}`);
            lines.push("");
            lines.push(
              "Automated providers are failing right now, so no verified profile match could be returned.",
            );
            lines.push(`Search provider failure: ${searchFailureSummary}`);
            lines.push(enrichFallbackStatus);
            lines.push("Manual lookup links:");
            lines.push(`- LinkedIn search: ${links.linkedin}`);
            lines.push(`- GitHub search: ${links.github}`);
            lines.push(`- Twitter/X search: ${links.twitter}`);
            lines.push("");
            lines.push(
              "Tip: once search providers recover (keys/network/endpoint), rerun /leadfind for verified scored matches.",
            );
            return { text: lines.join("\n") };
          }

          return {
            text:
              `Profile lookup failed: ${message}` +
              (isSearchProviderOutageError(message)
                ? "\n\nSearch providers failed (Serper/Tavily). Common causes: insufficient credits/quota, plan limits, invalid key, or endpoint/network issues."
                : ""),
          };
        }
      },
    });

    if (!hasAllProviders) {
      api.logger.warn(
        "[lead-enrichment] missing required API keys — find_profiles tool will not be registered. " +
          "Set serperApiKey/tavilyApiKey (and optionally pdlApiKey/hunterApiKey) " +
          "or SERPER_API_KEY/TAVILY_API_KEY/PDL_API_KEY/HUNTER_API_KEY.",
      );
      return;
    }

    api.registerTool(
      createFindProfilesTool({
        serperApiKey,
        tavilyApiKey,
        pdlApiKey,
        pdlApiUrl,
        hunterApiKey,
        hunterApiUrl,
      }),
    );
  },
};

export default plugin;
