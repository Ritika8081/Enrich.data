import type { SearchResult } from "./extract_profiles.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompanyEvidence = {
  type:
    | "company-website"
    | "business-directory"
    | "linkedin-profile"
    | "api-enrichment"
    | "email-domain-fallback";
  name: string;
  domain: string | null;
  url: string;
  /** Which directory the result came from (e.g. "indiamart"). */
  source?: string;
  matchedSignals: {
    emailDomain?: boolean;
    phone?: boolean;
    name?: boolean;
    cityMatchesLead?: boolean;
  };
};

export type InferredCompany = {
  name: string;
  domain: string | null;
  /** 0–100 confidence score. */
  confidence: number;
  sources: CompanyEvidence[];
};

export type LinkedinProfileInsights = {
  company: string | null;
  location: string | null;
  experienceYears: number | null;
  sourceUrl: string;
  sourceTier: "accepted-linkedin" | "candidate-linkedin" | "enrich";
};

// ---------------------------------------------------------------------------
// Email domain helpers
// ---------------------------------------------------------------------------

const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.in",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "protonmail.com",
  "rediffmail.com",
  "ymail.com",
  "live.com",
  "msn.com",
  "me.com",
]);

/**
 * Returns the domain portion of an email only when it is a recognisable
 * business / custom domain.  Free / webmail providers return null.
 */
export function getDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split("@");
  const domain = parts[1];
  if (!domain) return null;
  if (FREE_EMAIL_PROVIDERS.has(domain)) return null;
  return domain;
}

// ---------------------------------------------------------------------------
// Company website parsing
// ---------------------------------------------------------------------------

function parseOrgSignals(html: string): {
  orgSchemaName: string | null;
  metaOgSiteName: string | null;
  title: string | null;
} {
  // Try application/ld+json  Organization schema first.
  let orgSchemaName: string | null = null;
  const ldMatches = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const m of ldMatches) {
    try {
      const parsed: unknown = JSON.parse(m[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (
          item != null &&
          typeof item === "object" &&
          (item as Record<string, unknown>)["@type"] === "Organization" &&
          typeof (item as Record<string, unknown>).name === "string"
        ) {
          orgSchemaName = ((item as Record<string, unknown>).name as string).trim();
          break;
        }
      }
    } catch {}
    if (orgSchemaName) break;
  }

  const ogMatch =
    html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  const metaOgSiteName = ogMatch?.[1]?.trim() ?? null;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title =
    titleMatch?.[1]
      ?.replace(/&amp;/g, "&")
      .replace(/&#\d+;/g, "")
      .trim() ?? null;

  return { orgSchemaName, metaOgSiteName, title };
}

function cleanCompanyNameFromTitle(title: string | null): string | null {
  if (!title) return null;
  const clean = title
    .replace(/^(home\s*[-|:–]\s*|welcome\s+to\s+|official\s+site\s+of\s+)/i, "")
    .replace(
      /\s*[-|:–]\s*(home|official\s+site|website|online|india|\.com|\.in|\.net|\.org)\s*$/i,
      "",
    )
    .trim();
  return clean.length >= 2 ? clean : null;
}

/** Converts a bare domain to a title-cased name as a last resort. */
function fallbackFromDomain(domain: string): string {
  const base = domain.replace(/\.[a-z]{2,6}(\.[a-z]{2})?$/, "");
  return base
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Fetches a company website and extracts its canonical name via LD+JSON,
 * og:site_name, <title>, or domain heuristic.
 *
 * Returns null on network error or non-200 response.
 */
export async function fetchCompanySiteEvidence(domain: string): Promise<CompanyEvidence | null> {
  try {
    const response = await fetch(`https://${domain}`, {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const { orgSchemaName, metaOgSiteName, title } = parseOrgSignals(html);
    const name =
      orgSchemaName ??
      metaOgSiteName ??
      cleanCompanyNameFromTitle(title) ??
      fallbackFromDomain(domain);
    return {
      type: "company-website",
      name,
      domain,
      url: `https://${domain}`,
      matchedSignals: { emailDomain: true },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Business directory queries
// ---------------------------------------------------------------------------

export type DirectoryQuery = { q: string; tag: string };

type DirectorySupportKind = "phone" | "nameCity" | "businessEmail";

type DirectorySourceConfig = {
  id: string;
  domains: string[];
  supports: DirectorySupportKind[];
};

type CountryDirectoryConfig = {
  sources: DirectorySourceConfig[];
};

const DIRECTORY_CONFIG: Record<string, CountryDirectoryConfig> = {
  IN: {
    sources: [
      {
        id: "indiamart",
        domains: ["indiamart.com"],
        supports: ["phone", "nameCity", "businessEmail"],
      },
      {
        id: "justdial",
        domains: ["justdial.com"],
        supports: ["phone"],
      },
      {
        id: "tradeindia",
        domains: ["tradeindia.com"],
        supports: ["businessEmail"],
      },
    ],
  },
  MY: {
    sources: [
      {
        id: "yellowbees",
        domains: ["yellowbees.com.my"],
        supports: ["nameCity", "businessEmail"],
      },
      {
        id: "bizworldmy",
        domains: ["dir.businessworld.com.my"],
        supports: ["nameCity", "businessEmail"],
      },
      {
        id: "localbizmy",
        domains: ["localbiznetwork.com"],
        supports: ["nameCity"],
      },
    ],
  },
  SG: {
    sources: [
      {
        id: "ypsg",
        domains: ["yellowpages.com.sg", "yps.com.sg"],
        supports: ["nameCity", "businessEmail"],
      },
      {
        id: "sgdir",
        domains: ["singaporeleads.com", "singapore-business-directory.com"],
        supports: ["nameCity"],
      },
    ],
  },
  AE: {
    sources: [
      {
        id: "uaedir",
        domains: ["uaebusinessdirectory.com", "uaecompanies.ae", "uaeonlinedirectory.com"],
        supports: ["nameCity", "businessEmail"],
      },
      {
        id: "dubaidir",
        domains: ["dubai-businessdirectory.com"],
        supports: ["nameCity"],
      },
    ],
  },
};

/**
 * Build India-specific business directory search queries for phone/email/name.
 * Only runs when countryIso is "IN" — returns empty array otherwise.
 */
export function buildBusinessDirectoryQueries(lead: {
  name: string;
  phone?: string;
  email?: string;
  city?: string;
  countryIso?: string;
}): DirectoryQuery[] {
  if (!lead.countryIso) return [];
  const cfg = DIRECTORY_CONFIG[lead.countryIso];
  if (!cfg) return [];

  const queries: DirectoryQuery[] = [];
  for (const source of cfg.sources) {
    const siteFilters = source.domains.map((domain) => `site:${domain}`).join(" OR ");

    if (source.supports.includes("phone") && lead.phone) {
      queries.push({
        q: `"${lead.phone}" ${siteFilters}`,
        tag: `dir-phone-${source.id}`,
      });
    }

    if (source.supports.includes("nameCity") && lead.name && lead.city) {
      queries.push({
        q: `"${lead.name}" "${lead.city}" ${siteFilters}`,
        tag: `dir-name-city-${source.id}`,
      });
    }

    if (source.supports.includes("businessEmail") && lead.email && getDomain(lead.email)) {
      queries.push({
        q: `"${lead.email}" ${siteFilters}`,
        tag: `dir-email-${source.id}`,
      });
    }
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Directory search-result parsing
// ---------------------------------------------------------------------------

const DIRECTORY_SOURCES: Array<{ pattern: RegExp; source: string }> = Object.values(
  DIRECTORY_CONFIG,
)
  .flatMap((country) => country.sources)
  .flatMap((source) =>
    source.domains.map((domain) => ({
      pattern: new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      source: source.id,
    })),
  );

function getDirectorySource(url: string): string | null {
  for (const { pattern, source } of DIRECTORY_SOURCES) {
    if (pattern.test(url)) return source;
  }
  return null;
}

function extractCompanyFromDirectoryTitle(title: string): string | null {
  // Strip trailing directory-brand suffixes.
  const stripped = title
    .replace(
      /\s*[-|–—]\s*(business\s*directory|yellow\s*pages|yellowbees|indiamart|justdial|tradeindia|singapore\s*sme\s*directory)[^|–—]*$/i,
      "",
    )
    .trim();
  if (stripped.length < 2) return null;
  // Take the first dash/pipe-separated segment as the company name.
  const firstSeg = stripped.split(/\s*[-|–—]\s*/)[0]?.trim();
  return firstSeg && firstSeg.length >= 2 ? firstSeg : stripped;
}

/**
 * Scans already-collected search results for directory URLs and extracts
 * company evidence.  No additional HTTP requests are made.
 */
// URL patterns that list people as customers/buyers, not as business owners.
const SKIP_URL_PATH_RE = /\/(testimonial|testimonials|review|reviews|feedback|buyers?)\b/i;

export function extractCompanyFromSearchResults(
  results: SearchResult[],
  lead: { name: string; phone?: string },
): CompanyEvidence[] {
  const evidenceList: CompanyEvidence[] = [];
  const phone = lead.phone?.replace(/\D+/g, "");
  const fullNameLower = lead.name.toLowerCase();

  for (const result of results) {
    const url = result.url ?? "";
    const source = getDirectorySource(url);
    if (!source) continue;

    // Skip pages that list people as buyers/reviewers, not as business owners.
    if (SKIP_URL_PATH_RE.test(url)) continue;

    const combined = `${result.title ?? ""} ${result.description ?? ""}`.toLowerCase();
    const digitsFromText = combined.replace(/\D+/g, "");
    const phoneMatch = Boolean(
      phone &&
      phone.length >= 8 &&
      // Match full E.164 digits or national (last 10) digits.
      (digitsFromText.includes(phone) ||
        (phone.length >= 10 && digitsFromText.includes(phone.slice(-10)))),
    );
    // Require the full name as an exact phrase to avoid scattered-token false
    // positives (e.g. "Ritika Amit Kumar" + "Varun Mishra" matching "Ritika Mishra").
    const nameMatch = combined.includes(fullNameLower);

    // Need at least one strong signal for company attribution.
    if (!phoneMatch && !nameMatch) continue;

    const companyName = extractCompanyFromDirectoryTitle(result.title ?? "");
    if (!companyName) continue;

    evidenceList.push({
      type: "business-directory",
      name: companyName,
      domain: null,
      url,
      source,
      matchedSignals: { phone: phoneMatch, name: nameMatch },
    });
  }

  return evidenceList;
}

// ---------------------------------------------------------------------------
// LinkedIn title parsing
// ---------------------------------------------------------------------------

function extractCompanyFromLinkedinTitle(title: string): string | null {
  // "Name - Title at Company | LinkedIn" → "Company"
  const atMatch = title.match(/\bat\s+([\w\s&.,'-]+?)(?:\s*[-|]|$)/i);
  if (!atMatch) return null;

  const company = atMatch[1]?.trim() ?? "";
  if (!company) return null;

  // Do not treat education-role titles as employer evidence.
  const prefix = title.slice(0, atMatch.index).toLowerCase();
  const isEducationRole = /\b(student|attended|alumni|undergraduate|postgraduate|intern)\b/i.test(
    prefix,
  );
  const isEducationOrg = /\b(university|college|school|institute|academy)\b/i.test(company);

  if (isEducationRole && isEducationOrg) {
    return null;
  }

  return company;
}

function extractCompanyFromLinkedinTitleFallback(title: string): string | null {
  const withoutLinkedin = title
    .replace(/\|\s*linkedin\s*$/i, "")
    .replace(/-\s*linkedin\s*$/i, "")
    .trim();

  const segments = withoutLinkedin
    .split(/\s*[-–—]\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length < 2) return null;
  const candidate = segments[segments.length - 1] ?? "";
  if (!candidate) return null;

  const lower = candidate.toLowerCase();
  if (/\d/.test(candidate)) return null;
  if (candidate.includes(",")) return null;
  if (lower.includes("linkedin") || lower.includes("professional profile")) return null;
  if (/\b(student|attended|alumni|intern|undergraduate|postgraduate)\b/i.test(lower)) {
    return null;
  }
  if (/\b(university|college|school|institute|academy)\b/i.test(lower)) {
    return null;
  }

  return candidate;
}

function extractCompanyFromLinkedinDescription(description: string): string | null {
  if (!description) return null;

  const normalized = description.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const looksLikeCompany = (value: string): boolean => {
    const candidate = value.trim();
    if (!candidate) return false;
    if (candidate.length < 2 || candidate.length > 60) return false;
    if (candidate.split(/\s+/).length > 7) return false;

    const lower = candidate.toLowerCase();
    if (
      lower.includes("linkedin") ||
      lower.includes("experience") ||
      lower.includes("education") ||
      lower.includes("connection") ||
      lower.includes("follower") ||
      lower.includes("years") ||
      lower.includes("months")
    ) {
      return false;
    }

    if (
      lower.includes("building") ||
      lower.includes("solve") ||
      lower.includes("hands-on") ||
      lower.includes("real-world") ||
      lower.includes("web applications") ||
      lower.includes("developer with") ||
      lower.startsWith("hi, i")
    ) {
      return false;
    }

    if (/[@]|\b(part[- ]?time|internship|student)\b/i.test(candidate)) {
      return false;
    }

    return true;
  };

  const lines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Structured provider snippets often look like:
  // Name\nCompany\nLocation\n...
  if (lines.length >= 2) {
    const secondLine = lines[1] ?? "";
    if (looksLikeCompany(secondLine) && !looksLikeLocation(secondLine)) {
      return secondLine;
    }
  }

  // Common snippet shape: "... Experience. Fixit. 1 year ... Education. ..."
  const expMatch = normalized.match(
    /(?:^|\b)experience\b[\s:.-]+([^.|]{2,80}?)(?:\s*\.|\s+\d+\s+year|\s*\||\s+-\s+|$)/i,
  );
  const candidate = expMatch?.[1]?.trim();
  if (!candidate) return null;

  if (/^(n\/?a|none|na)$/i.test(candidate)) return null;
  if (/\b(university|college|school|institute|academy)\b/i.test(candidate)) return null;
  if (!looksLikeCompany(candidate)) return null;

  return candidate;
}

function canonicalizeLinkedinProfileUrl(url: string): string | null {
  const match = url.match(/linkedin\.com\/in\/([\w%-]+)/i);
  return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}` : null;
}

function looksLikeLocation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length < 5 || trimmed.length > 80) return false;
  if (/\d/.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  const singleWordCountryLike = new Set([
    "malaysia",
    "singapore",
    "indonesia",
    "thailand",
    "vietnam",
    "philippines",
    "india",
    "china",
    "japan",
    "australia",
    "canada",
    "germany",
    "france",
    "italy",
    "spain",
    "netherlands",
    "sweden",
    "norway",
    "denmark",
    "finland",
    "switzerland",
    "austria",
    "belgium",
    "ireland",
    "portugal",
    "poland",
    "turkey",
    "brazil",
    "mexico",
    "argentina",
    "chile",
    "colombia",
    "peru",
    "egypt",
    "kenya",
    "nigeria",
  ]);

  if (!trimmed.includes(",")) {
    return singleWordCountryLike.has(lower);
  }

  if (
    lower.includes("linkedin") ||
    lower.includes("professional profile") ||
    lower.includes("experience") ||
    lower.includes("connections")
  ) {
    return false;
  }

  return true;
}

function extractLinkedinLocation(title: string, description: string): string | null {
  const candidates: string[] = [];
  const titleSegments = title
    .split(/[|•·]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const descriptionSegments = description
    .split(/[|•·]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  candidates.push(...titleSegments, ...descriptionSegments);

  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.replace(/\b(experience|education)\b[\s\S]*$/i, "").trim();
    if (looksLikeLocation(candidate)) return candidate;
  }

  return null;
}

function extractExperienceYears(description: string): number | null {
  if (!description) return null;

  const yearsMonths = description.match(/(\d{1,2})\s+years?\s+(\d{1,2})\s+months?/i);
  if (yearsMonths) {
    const years = Number(yearsMonths[1]);
    const months = Number(yearsMonths[2]);
    if (Number.isFinite(years) && Number.isFinite(months)) {
      return Math.round((years + months / 12) * 10) / 10;
    }
  }

  const yearsOnly = description.match(/(\d{1,2}(?:\.\d+)?)\+?\s+years?/i);
  if (yearsOnly) {
    const years = Number(yearsOnly[1]);
    if (Number.isFinite(years)) return years;
  }

  const monthsOnly = description.match(/(\d{1,2})\s*(?:mos?|months?)\b/i);
  if (monthsOnly) {
    const months = Number(monthsOnly[1]);
    if (Number.isFinite(months)) {
      return Math.round((months / 12) * 10) / 10;
    }
  }

  const yearSingular = description.match(/(\d{1,2})\s+year\b/i);
  if (yearSingular) {
    const years = Number(yearSingular[1]);
    if (Number.isFinite(years)) return years;
  }

  return null;
}

export function extractLinkedinInsightsFromAccepted(
  acceptedProfiles: Array<{ platform: string; url: string }>,
  allResults: SearchResult[],
): LinkedinProfileInsights | null {
  const linkedinUrls = new Set(
    acceptedProfiles
      .filter((profile) => profile.platform === "linkedin")
      .map((profile) => canonicalizeLinkedinProfileUrl(profile.url))
      .filter((url): url is string => Boolean(url)),
  );
  if (linkedinUrls.size === 0) return null;

  let best: LinkedinProfileInsights | null = null;
  let bestScore = -1;

  for (const result of allResults) {
    const canonical = canonicalizeLinkedinProfileUrl(result.url ?? "");
    if (!canonical || !linkedinUrls.has(canonical)) continue;

    const title = result.title ?? "";
    const description = result.description ?? "";
    const company =
      extractCompanyFromLinkedinDescription(description) ??
      extractCompanyFromLinkedinTitle(title) ??
      extractCompanyFromLinkedinTitleFallback(title);
    const location = extractLinkedinLocation(title, description);
    const experienceYears = extractExperienceYears(description);
    const score =
      Number(Boolean(company)) + Number(Boolean(location)) + Number(experienceYears != null);

    if (score > bestScore) {
      bestScore = score;
      best = {
        company: company ?? null,
        location,
        experienceYears,
        sourceUrl: result.url ?? canonical,
        sourceTier: "accepted-linkedin",
      };
    }
  }

  if (!best) return null;
  if (!best.company && !best.location && best.experienceYears == null) return null;
  return best;
}

/**
 * Extracts company evidence from the titles of accepted LinkedIn profiles
 * present in the already-collected search results.
 */
export function extractCompanyFromAcceptedLinkedin(
  acceptedProfiles: Array<{ platform: string; url: string }>,
  allResults: SearchResult[],
): CompanyEvidence[] {
  const linkedinUrls = new Set(
    acceptedProfiles
      .filter((p) => p.platform === "linkedin")
      .map((p) => canonicalizeLinkedinProfileUrl(p.url))
      .filter((url): url is string => Boolean(url)),
  );
  if (linkedinUrls.size === 0) return [];

  const evidenceList: CompanyEvidence[] = [];
  for (const result of allResults) {
    const canonicalUrl = canonicalizeLinkedinProfileUrl(result.url ?? "");
    if (!canonicalUrl || !linkedinUrls.has(canonicalUrl)) continue;
    const company =
      extractCompanyFromLinkedinDescription(result.description ?? "") ??
      extractCompanyFromLinkedinTitle(result.title ?? "") ??
      extractCompanyFromLinkedinTitleFallback(result.title ?? "");
    if (!company) continue;
    evidenceList.push({
      type: "linkedin-profile",
      name: company,
      domain: null,
      url: result.url ?? canonicalUrl,
      matchedSignals: { name: true },
    });
  }
  return evidenceList;
}

// ---------------------------------------------------------------------------
// Company scoring
// ---------------------------------------------------------------------------

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(pvt|ltd|limited|private|inc|llc|llp|corp|company|co)\b\.?/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Groups evidence by company identity and returns the highest-scored candidate.
 */
export function scoreCompanyEvidence(evidenceList: CompanyEvidence[]): InferredCompany | null {
  if (evidenceList.length === 0) return null;

  const byKey = new Map<string, CompanyEvidence[]>();
  for (const ev of evidenceList) {
    // Group by normalized company name so that evidence from a website and a
    // directory listing for the same company merges into one bucket.
    const key = normalizeCompanyName(ev.name);
    if (!key) continue;
    const group = byKey.get(key) ?? [];
    group.push(ev);
    byKey.set(key, group);
  }

  let best: InferredCompany | null = null;

  for (const [, group] of byKey) {
    let score = 0;
    const sourceTypes = new Set<string>();

    for (const ev of group) {
      if (ev.type === "company-website") score += 40;
      else if (ev.type === "business-directory") score += 35;
      else if (ev.type === "linkedin-profile") score += 25;
      else if (ev.type === "api-enrichment") score += 35;
      else if (ev.type === "email-domain-fallback") score += 15;

      if (ev.matchedSignals.emailDomain) score += 30;
      if (ev.matchedSignals.phone) score += 20;
      if (ev.matchedSignals.name) score += 10;
      if (ev.matchedSignals.cityMatchesLead) score += 5;

      sourceTypes.add(ev.type);
    }

    // Bonus for corroboration across multiple source types.
    if (sourceTypes.size >= 2) score += 15;
    score = Math.min(score, 100);

    if (!best || score > best.confidence) {
      const exemplar = group[0];
      best = {
        name: exemplar.name,
        domain: exemplar.domain ?? group.find((g) => g.domain)?.domain ?? null,
        confidence: score,
        sources: group,
      };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Infers the company associated with a lead by combining:
 *   1. Email domain → company website fetch
 *   2. Business directory results already in allResults
 *   3. Accepted LinkedIn profile titles
 */
export async function inferCompanyFromLead(
  lead: { name: string; email?: string; phone?: string },
  allResults: SearchResult[],
  acceptedProfiles: Array<{ platform: string; url: string }>,
): Promise<InferredCompany | null> {
  const evidence: CompanyEvidence[] = [];

  // 1. Business email domain → fetch company site for authoritative name.
  const domain = getDomain(lead.email ?? "");
  if (domain) {
    const ev = await fetchCompanySiteEvidence(domain);
    if (ev) evidence.push(ev);
  }

  // 2. Directory snippets from already-completed searches (no extra HTTP).
  const dirEvidence = extractCompanyFromSearchResults(allResults, lead);
  evidence.push(...dirEvidence);

  // 3. Accepted LinkedIn profile title parsing.
  const linkedinEvidence = extractCompanyFromAcceptedLinkedin(acceptedProfiles, allResults);
  evidence.push(...linkedinEvidence);

  const inferred = scoreCompanyEvidence(evidence);
  if (inferred) {
    return inferred;
  }

  // 4. Safe fallback: if we only have a business email domain but no other
  // evidence, still surface a low-confidence company guess from the domain.
  if (domain) {
    const fallbackName = fallbackFromDomain(domain);
    if (fallbackName) {
      return {
        name: fallbackName,
        domain,
        confidence: 35,
        sources: [
          {
            type: "email-domain-fallback",
            name: fallbackName,
            domain,
            url: `https://${domain}`,
            matchedSignals: { emailDomain: true },
          },
        ],
      };
    }
  }

  return null;
}
