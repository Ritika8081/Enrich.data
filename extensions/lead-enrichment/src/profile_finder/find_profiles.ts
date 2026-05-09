import {
  buildBusinessDirectoryQueries,
  extractLinkedinInsightsFromAccepted,
  getDomain,
  inferCompanyFromLead,
} from "./company_inference.js";
import type { InferredCompany, LinkedinProfileInsights } from "./company_inference.js";
import {
  calculateConfidence,
  extractProfiles,
  getStrongCandidatesByPlatform,
} from "./extract_profiles.js";
import type { SearchResult, SocialProfiles } from "./extract_profiles.js";
import {
  geoBoostFromText,
  geoConflictFromText,
  geoQueriesForName,
  getCountryFromPhone,
} from "./geo_utils.js";

export type { SearchResult, SocialProfiles };

export type FindProfilesInput = {
  name: string;
  email?: string;
  phone?: string;
};

export type EvidenceLink = {
  url: string;
  title?: string;
  description?: string;
  platform: "linkedin" | "github" | "twitter" | "other";
  reason:
    | "github-related-repo"
    | "github-readme-profile"
    | "github-profile-linkedin-link"
    | "social-mention-post"
    | "email-correlated-result"
    | "phone-correlated-result"
    | "geo-signal-match"
    | "weak-linkedin-candidate"
    | "pdl-lookup"
    | "hunter-lookup";
};

export type ClassifiedProfile = {
  platform: "linkedin" | "github" | "twitter";
  url: string;
  confidence: number;
  evidence: string[];
};

export type ProfileFinderResult = {
  profiles: SocialProfiles;
  confidence: number;
  confidenceByPlatform: Record<"linkedin" | "github" | "twitter", number>;
  acceptedProfiles: ClassifiedProfile[];
  strongCandidates: Array<{
    platform: "linkedin" | "github" | "twitter";
    url: string;
    score: number;
    corroborated: boolean;
    evidence: string[];
  }>;
  candidateProfiles: ClassifiedProfile[];
  rejectionReasons: string[];
  company: InferredCompany | null;
  linkedinInsights: LinkedinProfileInsights | null;
  queriesRun: string[];
  evidence: EvidenceLink[];
  providerSignals: {
    serperResults: number;
    tavilyResults: number;
    pdlUsed: boolean;
    pdlContributed: boolean;
    hunterUsed: boolean;
    hunterContributed: boolean;
  };
  resultOrigins: {
    linkedin: "pdl" | "hunter" | "github-link" | "search" | "none";
    github: "pdl" | "hunter" | "search" | "none";
    twitter: "pdl" | "hunter" | "search" | "none";
    company: "pdl" | "hunter" | "linkedin-insights" | "search-inference" | "none";
  };
  debugSummary?: {
    detectedCountryIso: string | null;
    activatedDirectorySources: string[];
  };
  queryDebug?: Array<{ query: string; results: SearchResult[] }>;
};

/**
 * A function that performs a single web search and returns a list of results.
 * The caller provides this — typically backed by Brave Search API.
 */
export type WebSearchFn = (query: string, count?: number) => Promise<SearchResult[]>;

export type EnrichResult = {
  linkedin?: string | null;
  github?: string | null;
  twitter?: string | null;
  facebook?: string | null;
  jobTitle?: string | null;
  industry?: string | null;
  emails?: string[] | null;
  company?: {
    name?: string | null;
    domain?: string | null;
    confidence?: number | null;
  } | null;
  linkedinInsights?: {
    company?: string | null;
    location?: string | null;
    experienceYears?: number | null;
  } | null;
};

export type EnrichLookupFn = (input: FindProfilesInput) => Promise<EnrichResult | null>;

function normalizeUrl(url: string): string {
  return url.replace(/[?#].*$/, "").replace(/\/$/, "");
}

function resolveProfileOrigin(params: {
  platform: "linkedin" | "github" | "twitter";
  selectedUrl: string | null;
  evidence: EvidenceLink[];
}): "pdl" | "hunter" | "github-link" | "search" | "none" {
  if (!params.selectedUrl) return "none";

  const selected = normalizeUrl(params.selectedUrl).toLowerCase();
  const matched = params.evidence.find(
    (item) =>
      item.platform === params.platform && normalizeUrl(item.url).toLowerCase() === selected,
  );

  if (!matched) return "search";
  if (matched.reason === "pdl-lookup") return "pdl";
  if (matched.reason === "hunter-lookup") return "hunter";
  if (matched.reason === "github-profile-linkedin-link" && params.platform === "linkedin") {
    return "github-link";
  }

  return "search";
}

function inferPlatform(url: string): EvidenceLink["platform"] {
  const lower = url.toLowerCase();
  if (lower.includes("linkedin.com/")) return "linkedin";
  if (lower.includes("github.com/")) return "github";
  if (lower.includes("twitter.com/") || lower.includes("x.com/")) return "twitter";
  return "other";
}

function extractGithubHandle(url: string): string | null {
  const match = url.match(/github\.com\/([\w-]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function isGithubRepoUrl(url: string): boolean {
  return /github\.com\/[\w-]+\/[\w.-]+/i.test(url);
}

function isXOrTwitterStatusUrl(url: string): boolean {
  return /(?:twitter|x)\.com\/[\w]+\/status\/\d+/i.test(url);
}

function canonicalizeLinkedinProfileUrl(url: string): string | null {
  const match = url.match(/linkedin\.com\/in\/([\w%-]+)/i);
  return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}` : null;
}

function deriveCompanyHintFromEmail(email?: string): string | undefined {
  const domain = getDomain(email ?? "");
  if (!domain) return undefined;
  const base = domain.split(".")[0] ?? "";
  const cleaned = base
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
  if (!cleaned || cleaned.length < 3) return undefined;
  return cleaned;
}

function hasLinkedinQueryTarget(query: string | undefined): boolean {
  return (query ?? "").toLowerCase().includes("site:linkedin.com/in");
}

function getNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function hasStrongNameAnchorForInput(result: SearchResult, inputName: string): boolean {
  const fullName = inputName.trim().toLowerCase();
  if (!fullName) return false;

  const nameTokens = getNameTokens(fullName);
  if (nameTokens.length < 2) return false;

  const title = (result.title ?? "").toLowerCase();
  const description = (result.description ?? "").toLowerCase();
  const url = (result.url ?? "").toLowerCase();
  const content = `${title} ${description}`;

  if (content.includes(fullName)) {
    return true;
  }

  const matchedInContent = nameTokens.filter((token) => content.includes(token));
  if (matchedInContent.length === nameTokens.length) {
    return true;
  }

  const linkedinHandle = url.match(/linkedin\.com\/in\/([\w%-]+)/i)?.[1]?.toLowerCase() ?? "";
  if (!linkedinHandle) {
    return false;
  }

  const matchedInHandle = nameTokens.filter((token) => linkedinHandle.includes(token));
  return matchedInHandle.length === nameTokens.length;
}

function selectedLinkedinLooksEmailOnlyCorroborated(
  selectedLinkedinUrl: string,
  results: SearchResult[],
  input: FindProfilesInput,
): boolean {
  const selectedCanonical = canonicalizeLinkedinProfileUrl(selectedLinkedinUrl);
  if (!selectedCanonical) return false;

  const normalizedEmail = input.email?.toLowerCase() ?? "";
  const normalizedPhone = input.phone?.replace(/\D+/g, "") ?? "";

  let hasLinkedinEmailQueryHit = false;
  let hasLinkedinPhoneQueryHit = false;
  let hasLiteralIdentityInResult = false;
  let hasNonEmailOrPhoneProfileHit = false;

  for (const result of results) {
    const candidateCanonical = canonicalizeLinkedinProfileUrl(result.url ?? "");
    if (!candidateCanonical || candidateCanonical !== selectedCanonical) {
      continue;
    }

    const content = `${result.title ?? ""} ${result.description ?? ""}`.toLowerCase();
    const digitsContent = content.replace(/\D+/g, "");

    if (normalizedEmail && content.includes(normalizedEmail)) {
      hasLiteralIdentityInResult = true;
    }

    if (normalizedPhone && normalizedPhone.length >= 8 && digitsContent.includes(normalizedPhone)) {
      hasLiteralIdentityInResult = true;
    }

    const targetsLinkedin = hasLinkedinQueryTarget(result.sourceQuery);
    if (result.fromEmailQuery && targetsLinkedin) {
      hasLinkedinEmailQueryHit = true;
    }

    if (result.fromPhoneQuery && targetsLinkedin) {
      hasLinkedinPhoneQueryHit = true;
    }

    if (!result.fromEmailQuery && !result.fromPhoneQuery && targetsLinkedin) {
      hasNonEmailOrPhoneProfileHit = true;
    }
  }

  if (hasLiteralIdentityInResult || hasNonEmailOrPhoneProfileHit) {
    return false;
  }

  return hasLinkedinEmailQueryHit || hasLinkedinPhoneQueryHit;
}

function countConflictingNameAnchoredLinkedinCandidates(
  selectedLinkedinUrl: string,
  results: SearchResult[],
  inputName: string,
): number {
  const selectedCanonical = canonicalizeLinkedinProfileUrl(selectedLinkedinUrl);
  if (!selectedCanonical) return 0;

  const candidates = new Set<string>();

  for (const result of results) {
    if (
      result.fromEmailQuery ||
      result.fromPhoneQuery ||
      !hasLinkedinQueryTarget(result.sourceQuery)
    ) {
      continue;
    }

    const canonical = canonicalizeLinkedinProfileUrl(result.url ?? "");
    if (!canonical || canonical === selectedCanonical) {
      continue;
    }

    if (hasStrongNameAnchorForInput(result, inputName)) {
      candidates.add(canonical);
    }
  }

  return candidates.size;
}

function collectLinkedinCandidates(results: SearchResult[], input: FindProfilesInput): string[] {
  const countryInfo = getCountryFromPhone(input.phone);
  const name = input.name;
  const fullName = name.trim().toLowerCase();
  const nameTokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  const byUrl = new Map<string, number>();
  for (const result of results) {
    const canonical = canonicalizeLinkedinProfileUrl(result.url ?? "");
    if (!canonical) continue;

    const content = `${result.title ?? ""} ${result.description ?? ""}`.toLowerCase();
    if (geoConflictFromText(content, countryInfo).conflicts.length > 0) {
      continue;
    }

    const handle = canonical.split("/").pop()?.toLowerCase() ?? "";
    const tokenHits = nameTokens.reduce(
      (count, token) => count + (content.includes(token) ? 1 : 0),
      0,
    );
    const handleTokenHits = nameTokens.reduce(
      (count, token) => count + (handle.includes(token) ? 1 : 0),
      0,
    );
    const hasNameAnchor =
      tokenHits > 0 ||
      handleTokenHits > 0 ||
      (fullName.length > 0 &&
        (content.includes(fullName) || handle.includes(fullName.replace(/\s+/g, ""))));
    if (!hasNameAnchor) {
      continue;
    }

    const queryBoost = result.fromEmailQuery || result.fromPhoneQuery ? 1 : 0;
    const score = tokenHits + handleTokenHits + queryBoost;

    const current = byUrl.get(canonical) ?? 0;
    if (score > current) {
      byUrl.set(canonical, score);
    }
  }

  return [...byUrl.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([url]) => url);
}

function hasStrongLinkedinCorroboration(
  selectedLinkedinUrl: string,
  results: SearchResult[],
  input: FindProfilesInput,
): boolean {
  const canonicalSelected = canonicalizeLinkedinProfileUrl(selectedLinkedinUrl);
  if (!canonicalSelected) return false;

  const email = input.email?.toLowerCase();
  const phoneDigits = input.phone?.replace(/\D+/g, "");

  for (const result of results) {
    const canonicalCandidate = canonicalizeLinkedinProfileUrl(result.url ?? "");
    if (!canonicalCandidate || canonicalCandidate !== canonicalSelected) {
      continue;
    }

    // If this exact LinkedIn profile appears in an explicit email-targeted
    // LinkedIn query result, treat it as strong corroboration.
    if (
      result.fromEmailQuery &&
      (result.sourceQuery ?? "").toLowerCase().includes("site:linkedin.com/in")
    ) {
      return true;
    }

    const content = `${result.title ?? ""} ${result.description ?? ""}`.toLowerCase();
    const digitsContent = content.replace(/\D+/g, "");

    if (email && content.includes(email)) {
      return true;
    }

    if (phoneDigits && phoneDigits.length >= 8 && digitsContent.includes(phoneDigits)) {
      return true;
    }
  }

  return false;
}

function hasNameCompanyLinkedinCorroboration(
  selectedLinkedinUrl: string,
  results: SearchResult[],
  input: FindProfilesInput,
): boolean {
  const canonicalSelected = canonicalizeLinkedinProfileUrl(selectedLinkedinUrl);
  if (!canonicalSelected) return false;

  const fullName = input.name.trim().toLowerCase();
  const companyHint = deriveCompanyHintFromEmail(input.email);
  if (!fullName || !companyHint) return false;

  const compactName = fullName.replace(/[^a-z0-9]/g, "");
  const compactCompany = companyHint.replace(/[^a-z0-9]/g, "");

  for (const result of results) {
    const canonicalCandidate = canonicalizeLinkedinProfileUrl(result.url ?? "");
    if (!canonicalCandidate || canonicalCandidate !== canonicalSelected) {
      continue;
    }

    const content =
      `${result.title ?? ""} ${result.description ?? ""} ${result.url ?? ""}`.toLowerCase();
    const compactContent = content.replace(/[^a-z0-9]/g, "");

    const nameMatched = content.includes(fullName) || compactContent.includes(compactName);
    const companyMatched =
      content.includes(companyHint) ||
      (compactCompany.length >= 4 && compactContent.includes(compactCompany));

    if (nameMatched && companyMatched) {
      return true;
    }
  }

  return false;
}

function hasLiteralIdentityLinkedinCorroboration(
  selectedLinkedinUrl: string,
  results: SearchResult[],
  input: FindProfilesInput,
): boolean {
  const canonicalSelected = canonicalizeLinkedinProfileUrl(selectedLinkedinUrl);
  if (!canonicalSelected) return false;

  const email = input.email?.toLowerCase();
  const phoneDigits = input.phone?.replace(/\D+/g, "");

  for (const result of results) {
    const canonicalCandidate = canonicalizeLinkedinProfileUrl(result.url ?? "");
    if (!canonicalCandidate || canonicalCandidate !== canonicalSelected) {
      continue;
    }

    const content = `${result.title ?? ""} ${result.description ?? ""}`.toLowerCase();
    const digitsContent = content.replace(/\D+/g, "");

    if (email && content.includes(email)) {
      return true;
    }

    if (phoneDigits && phoneDigits.length >= 8 && digitsContent.includes(phoneDigits)) {
      return true;
    }
  }

  return false;
}

async function discoverLinkedinFromGithubProfile(githubProfileUrl: string): Promise<string | null> {
  const extractLinkedinCandidates = (input: string): string[] => {
    const decoded = input
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");

    const directMatches =
      decoded.match(/https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[a-z0-9][a-z0-9-_%]*\/?/gi) ??
      [];

    return [...new Set(directMatches)];
  };

  const pickCanonical = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      const canonical = canonicalizeLinkedinProfileUrl(candidate);
      if (canonical) {
        return canonical;
      }
    }
    return null;
  };

  try {
    const response = await fetch(githubProfileUrl, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (compatible; OpenClawLeadEnrichment/1.0)",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    return pickCanonical(extractLinkedinCandidates(html));
  } catch {
    return null;
  }
}

function discoverLinkedinFromGithubSearchEvidence(
  githubProfileUrl: string,
  results: SearchResult[],
): string | null {
  const canonicalGithub = normalizeGithubProfileUrl(githubProfileUrl);
  if (!canonicalGithub) return null;

  const candidates = new Set<string>();
  for (const result of results) {
    const resultGithub = normalizeGithubProfileUrl(result.url ?? "");
    if (!resultGithub || resultGithub !== canonicalGithub) {
      continue;
    }

    const content = `${result.title ?? ""} ${result.description ?? ""}`
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
    const matches =
      content.match(/https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[a-z0-9][a-z0-9-_%]*\/?/gi) ??
      [];

    for (const match of matches) {
      const canonicalLinkedin = canonicalizeLinkedinProfileUrl(match);
      if (canonicalLinkedin) {
        candidates.add(canonicalLinkedin);
      }
    }
  }

  if (candidates.size === 1) {
    return [...candidates][0] ?? null;
  }

  return null;
}

async function backfillLinkedinInsightsFromSelectedProfile(params: {
  search: WebSearchFn;
  linkedinUrl: string;
  input: FindProfilesInput;
}): Promise<LinkedinProfileInsights | null> {
  try {
    const queries = [
      `"${params.linkedinUrl}"`,
      `"${params.input.name}" "${params.linkedinUrl}"`,
    ];

    const byUrl = new Map<string, SearchResult>();
    for (const query of queries) {
      const results = await params.search(query, 5);
      for (const result of results) {
        const key = normalizeUrl(result.url ?? `${result.title ?? ""}|${result.description ?? ""}`);
        if (!byUrl.has(key)) {
          byUrl.set(key, {
            ...result,
            sourceQuery: query,
          });
        }
      }
    }

    const candidates = [...byUrl.values()];
    if (candidates.length === 0) {
      return null;
    }

    return extractLinkedinInsightsFromAccepted(
      [{ platform: "linkedin", url: params.linkedinUrl }],
      candidates,
    );
  } catch {
    return null;
  }
}

async function fetchLinkedinInsightsFromProfileUrl(
  linkedinUrl: string,
): Promise<LinkedinProfileInsights | null> {
  try {
    const response = await fetch(linkedinUrl, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    const title =
      html
        .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        ?.replace(/\s+/g, " ")
        .trim() ?? "";

    const ogDescription =
      html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i)?.[1] ??
      "";

    let company: string | null = null;
    let location: string | null = null;

    const ldJsonMatches = html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    );
    for (const match of ldJsonMatches) {
      try {
        const parsed = JSON.parse(match[1]);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item == null || typeof item !== "object") continue;
          const obj = item as Record<string, unknown>;
          const worksFor = obj.worksFor as Record<string, unknown> | undefined;
          const homeLocation = obj.homeLocation as Record<string, unknown> | undefined;
          const address = homeLocation?.address as Record<string, unknown> | undefined;

          if (!company && typeof worksFor?.name === "string") {
            company = worksFor.name.trim();
          }

          if (!location) {
            const locality =
              typeof address?.addressLocality === "string" ? address.addressLocality : null;
            const country =
              typeof address?.addressCountry === "string" ? address.addressCountry : null;
            if (locality && country) {
              location = `${locality}, ${country}`;
            } else if (locality) {
              location = locality;
            } else if (country) {
              location = country;
            }
          }
        }
      } catch {
        continue;
      }
    }

    if (!company) {
      const titleCompanyMatch = title.match(/-\s*([^|\-][^|]*?)\s*\|\s*LinkedIn/i);
      if (titleCompanyMatch?.[1]) {
        const candidate = titleCompanyMatch[1].trim();
        if (candidate && !/linkedin/i.test(candidate)) {
          company = candidate;
        }
      }
    }

    if (!company && ogDescription) {
      const companyAtMatch = ogDescription.match(/\bat\s+([^|,•·]{2,80})/i);
      if (companyAtMatch?.[1]) {
        company = companyAtMatch[1].trim();
      }
    }

    if (!location && ogDescription) {
      const locationMatch = ogDescription.match(/([A-Za-z .'-]+,\s*[A-Za-z .'-]{2,40})/);
      if (locationMatch?.[1]) {
        location = locationMatch[1].trim();
      }
    }

    if (!company && !location) {
      return null;
    }

    return {
      company,
      location,
      experienceYears: null,
      sourceUrl: linkedinUrl,
      sourceTier: "enrich",
    };
  } catch {
    return null;
  }
}

function buildEvidence(
  input: FindProfilesInput,
  results: SearchResult[],
  profiles: SocialProfiles,
): EvidenceLink[] {
  const selected = new Set(
    [profiles.linkedin, profiles.github, profiles.twitter]
      .filter((url): url is string => Boolean(url))
      .map((url) => normalizeUrl(url)),
  );

  const selectedGithubHandle = profiles.github ? extractGithubHandle(profiles.github) : null;
  const normalizedEmail = input.email?.toLowerCase();
  const normalizedPhone = input.phone?.replace(/\D+/g, "");
  const lowerName = input.name.toLowerCase();
  const countryInfo = getCountryFromPhone(input.phone);
  const nameTokens = lowerName
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  const evidenceByUrl = new Map<string, EvidenceLink>();

  for (const result of results) {
    const url = result.url;
    if (!url) {
      continue;
    }

    const normalized = normalizeUrl(url);
    if (selected.has(normalized)) {
      continue;
    }

    const title = result.title;
    const description = result.description;
    const haystack = `${title ?? ""} ${description ?? ""}`.toLowerCase();
    const platform = inferPlatform(url);

    let reason: EvidenceLink["reason"] | null = null;

    if (
      platform === "github" &&
      selectedGithubHandle &&
      isGithubRepoUrl(url) &&
      extractGithubHandle(url) === selectedGithubHandle
    ) {
      reason = normalized.endsWith(`/${selectedGithubHandle}`)
        ? "github-readme-profile"
        : "github-related-repo";
    } else if (platform === "twitter" && isXOrTwitterStatusUrl(url)) {
      const mentionsName = nameTokens.every((token) => haystack.includes(token));
      if (mentionsName || haystack.includes(lowerName)) {
        reason = "social-mention-post";
      }
    }

    if (!reason && normalizedEmail && haystack.includes(normalizedEmail)) {
      reason = "email-correlated-result";
    }

    if (!reason && normalizedPhone && haystack.includes(normalizedPhone)) {
      reason = "phone-correlated-result";
    }

    if (!reason) {
      const geo = geoBoostFromText(haystack, countryInfo);
      if (geo.matches.length > 0) {
        reason = "geo-signal-match";
      }
    }

    if (!reason) {
      continue;
    }

    if (!evidenceByUrl.has(normalized)) {
      evidenceByUrl.set(normalized, {
        url: normalized,
        title,
        description,
        platform,
        reason,
      });
    }
  }

  return [...evidenceByUrl.values()].slice(0, 10);
}

// LinkedIn post URLs embed the author's handle: /posts/{handle}_{slug}
// When that post was surfaced by an email/phone query we can infer the profile URL.
const LINKEDIN_POST_HANDLE_RE = /linkedin\.com\/posts\/([\w-]+)_/i;

/**
 * Synthesize LinkedIn profile candidates from post/activity URLs found in
 * email- or phone-targeted query results.
 *
 * The LinkedIn post URL path is `linkedin.com/posts/{handle}_{slug}`, so we
 * can derive `linkedin.com/in/{handle}`.  We keep the original result's title
 * and description so name-signal scoring still applies, and we set a
 * `site:linkedin.com/in` source query so the `fromEmailQuery` corroboration
 * bonus fires correctly.
 */
function inferLinkedinFromPosts(results: SearchResult[]): SearchResult[] {
  const synthetic: SearchResult[] = [];
  for (const result of results) {
    if (!result.fromEmailQuery && !result.fromPhoneQuery) continue;
    const url = result.url ?? "";
    const match = url.match(LINKEDIN_POST_HANDLE_RE);
    if (!match) continue;
    const handle = match[1];
    synthetic.push({
      url: `https://www.linkedin.com/in/${handle}/`,
      title: result.title,
      description: result.description,
      // Must include site:linkedin.com/in so queryTargetsPlatform returns true
      // and the fromEmailQuery/fromPhoneQuery corroboration bonus is applied.
      sourceQuery: `site:linkedin.com/in (inferred from post: ${handle})`,
      fromEmailQuery: result.fromEmailQuery,
      fromPhoneQuery: result.fromPhoneQuery,
    });
  }
  return synthetic;
}

/**
 * Build search queries from lead data.
 */
function buildQueries(input: FindProfilesInput): {
  queries: string[];
  detectedCountryIso: string | null;
  activatedDirectorySources: string[];
} {
  const { name, email, phone } = input;
  const countryInfo = getCountryFromPhone(phone);

  const directoryQueryDescriptors = buildBusinessDirectoryQueries({
    name,
    phone,
    email,
    city: countryInfo?.sampleCities?.[0],
    countryIso: countryInfo?.iso,
  });
  const directoryQueries = directoryQueryDescriptors.map((d) => d.q);
  const activatedDirectorySources = [
    ...new Set(
      directoryQueryDescriptors
        .map((d) => d.tag.match(/^dir-(?:phone|name-city|email)-(.+)$/)?.[1])
        .filter((source): source is string => Boolean(source)),
    ),
  ];

  const queries = [
    ...geoQueriesForName(name, countryInfo),
    `"${name}" site:linkedin.com/in`,
    `"${name}" site:github.com`,
    `"${name}" site:twitter.com`,
    `"${name}" site:x.com`,
    ...directoryQueries,
  ];

  if (email) {
    queries.push(`"${email}"`);
    queries.push(`"${email}" site:linkedin.com/in`);
    queries.push(`"${email}" site:github.com`);
    queries.push(`"${email}" site:twitter.com`);
  }

  if (phone) {
    queries.push(`"${phone}"`);
    queries.push(`"${phone}" site:linkedin.com/in`);
    queries.push(`"${phone}" site:github.com`);
    queries.push(`"${phone}" site:twitter.com`);
  }

  return {
    queries: [...new Set(queries)],
    detectedCountryIso: countryInfo?.iso ?? null,
    activatedDirectorySources,
  };
}

function classifyProfiles(
  profiles: SocialProfiles,
  evidence: EvidenceLink[],
  options?: {
    linkedinCandidates?: string[];
    linkedinStrongCandidates?: Array<{
      url: string;
      score: number;
      corroborated: boolean;
    }>;
  },
): {
  confidenceByPlatform: Record<"linkedin" | "github" | "twitter", number>;
  acceptedProfiles: ClassifiedProfile[];
  candidateProfiles: ClassifiedProfile[];
  rejectionReasons: string[];
} {
  const platforms: Array<"linkedin" | "github" | "twitter"> = ["linkedin", "github", "twitter"];
  const acceptedProfiles: ClassifiedProfile[] = [];
  const candidateProfiles: ClassifiedProfile[] = [];
  const rejectionReasons: string[] = [];

  const confidenceByPlatform = {
    linkedin: 0.1,
    github: 0.1,
    twitter: 0.1,
  };

  const evidenceByPlatform = new Map<"linkedin" | "github" | "twitter", EvidenceLink[]>();
  for (const platform of platforms) {
    evidenceByPlatform.set(
      platform,
      evidence.filter((item) => item.platform === platform),
    );
  }

  for (const platform of platforms) {
    const directUrl = profiles[platform];
    const platformEvidence = evidenceByPlatform.get(platform) ?? [];
    if (directUrl) {
      const directConfidence = platform === "linkedin" ? 0.9 : platform === "github" ? 0.86 : 0.82;
      confidenceByPlatform[platform] = directConfidence;
      acceptedProfiles.push({
        platform,
        url: directUrl,
        confidence: directConfidence,
        evidence: platformEvidence.slice(0, 3).map((item) => item.reason),
      });
      continue;
    }

    if (platform === "linkedin" && (options?.linkedinCandidates?.length ?? 0) > 0) {
      const linkedinStrong = options?.linkedinStrongCandidates ?? [];
      const nonCorroboratedStrong = linkedinStrong.filter((candidate) => !candidate.corroborated);
      const hasAmbiguousStrongSet = nonCorroboratedStrong.length >= 2;

      if (hasAmbiguousStrongSet) {
        rejectionReasons.push(
          "linkedin: multiple strong but non-corroborated matches; manual review required.",
        );
        continue;
      }

      const candidateUrl = options?.linkedinCandidates?.[0];
      if (!candidateUrl) {
        rejectionReasons.push("linkedin: no corroborated search results.");
        continue;
      }
      confidenceByPlatform[platform] = 0.4;
      candidateProfiles.push({
        platform,
        url: candidateUrl,
        confidence: 0.4,
        evidence: ["weak-linkedin-candidate"],
      });
      rejectionReasons.push("linkedin: no strong corroboration; returning candidates only.");
      continue;
    }

    if (platformEvidence.length > 0) {
      confidenceByPlatform[platform] = 0.45;
      candidateProfiles.push({
        platform,
        url: platformEvidence[0].url,
        confidence: 0.45,
        evidence: platformEvidence.slice(0, 3).map((item) => item.reason),
      });
      rejectionReasons.push(
        `${platform}: only indirect evidence found; no corroborated direct profile URL.`,
      );
      continue;
    }

    rejectionReasons.push(`${platform}: no corroborated search results.`);
  }

  return {
    confidenceByPlatform,
    acceptedProfiles,
    candidateProfiles,
    rejectionReasons,
  };
}

/**
 * Find social profiles for a lead by running web searches.
 *
 * @param input  - The lead's name, email, and/or phone number.
 * @param search - A web search function to call for each query.
 * @returns      - Discovered profiles, confidence score, and queries run.
 */
export async function findProfiles(
  input: FindProfilesInput,
  search: WebSearchFn,
  options?: {
    debug?: boolean;
    pdlLookup?: EnrichLookupFn;
    enrichLookup?: EnrichLookupFn;
  },
): Promise<ProfileFinderResult> {
  let pdlUsed = false;
  let hunterUsed = false;

  let pdlEnrich: EnrichResult | null = null;
  if (options?.pdlLookup) {
    pdlUsed = true;
    try {
      pdlEnrich = await options.pdlLookup(input);
    } catch {
      pdlEnrich = null;
    }
  }

  const queryBuild = buildQueries(input);
  const queries = queryBuild.queries;
  const allResults: SearchResult[] = [];
  let emailFound = false;
  const queryDebug: Array<{ query: string; results: SearchResult[] }> = [];
  const searchErrors: unknown[] = [];

  for (const query of queries) {
    let results: SearchResult[] = [];
    try {
      results = await search(query, 5);
    } catch (error) {
      searchErrors.push(error);
      if (options?.debug) {
        queryDebug.push({ query, results: [] });
      }
      continue;
    }

    const isEmailQuery = Boolean(input.email && query.includes(input.email));
    const isPhoneQuery = Boolean(input.phone && query.includes(input.phone));
    const taggedResults = results.map((result) => ({
      ...result,
      sourceQuery: query,
      fromEmailQuery: isEmailQuery,
      fromPhoneQuery: isPhoneQuery,
    }));
    allResults.push(...taggedResults);

    if (options?.debug) {
      queryDebug.push({ query, results: taggedResults });
    }

    // Check whether any result URL or description references the supplied email.
    if (input.email && !emailFound) {
      const lower = input.email.toLowerCase();
      emailFound = results.some(
        (r) => r.url?.toLowerCase().includes(lower) || r.description?.toLowerCase().includes(lower),
      );
    }
  }

  if (searchErrors.length > 0 && searchErrors.length === queries.length) {
    throw searchErrors[0] instanceof Error ? searchErrors[0] : new Error(String(searchErrors[0]));
  }

  const syntheticFromPosts = inferLinkedinFromPosts(allResults);
  const scoredResults = [...allResults, ...syntheticFromPosts];
  const companyHint = deriveCompanyHintFromEmail(input.email);
  const profiles = extractProfiles(scoredResults, { ...input, companyHint });
  const linkedinCandidates = collectLinkedinCandidates(scoredResults, input);

  const enrichmentEvidence: EvidenceLink[] = [];

  const maybeCanonical = (
    url: string | null | undefined,
    platform: "linkedin" | "github" | "twitter",
  ) => {
    if (!url) return null;
    if (platform === "linkedin") return canonicalizeLinkedinProfileUrl(url);
    if (platform === "github") {
      const match = url.match(/github\.com\/([\w-]+)/i);
      return match ? `https://github.com/${match[1]}` : null;
    }
    const match = url.match(/(?:twitter|x)\.com\/([\w]+)/i);
    return match ? `https://twitter.com/${match[1]}` : null;
  };

  const addEnrichEvidence = (
    platform: "linkedin" | "github" | "twitter",
    url: string,
    source: "pdl" | "hunter",
  ) => {
    enrichmentEvidence.push({
      url,
      platform,
      reason: source === "pdl" ? "pdl-lookup" : "hunter-lookup",
      title:
        source === "pdl"
          ? "Profile anchored by People Data Labs"
          : "Profile filled from Hunter lookup",
    });
  };

  const pdlLinkedin = maybeCanonical(pdlEnrich?.linkedin, "linkedin");
  const pdlGithub = maybeCanonical(pdlEnrich?.github, "github");
  const pdlTwitter = maybeCanonical(pdlEnrich?.twitter, "twitter");
  const searchLinkedinBeforePdl = profiles.linkedin;
  const searchLinkedinStronglyCorroborated = Boolean(
    searchLinkedinBeforePdl &&
    (hasStrongLinkedinCorroboration(searchLinkedinBeforePdl, scoredResults, input) ||
      hasNameCompanyLinkedinCorroboration(searchLinkedinBeforePdl, scoredResults, input)),
  );
  let pdlAnchoredLinkedin = false;

  if (pdlLinkedin) {
    const canonicalSearchLinkedin = searchLinkedinBeforePdl
      ? canonicalizeLinkedinProfileUrl(searchLinkedinBeforePdl)
      : null;
    const pdlAgreesWithSearch = Boolean(
      canonicalSearchLinkedin && canonicalSearchLinkedin === pdlLinkedin,
    );
    const canUsePdlLinkedin =
      !searchLinkedinBeforePdl || pdlAgreesWithSearch || !searchLinkedinStronglyCorroborated;

    if (canUsePdlLinkedin) {
      profiles.linkedin = pdlLinkedin;
      pdlAnchoredLinkedin = true;
      addEnrichEvidence("linkedin", pdlLinkedin, "pdl");
    }
  }

  if (!profiles.github && pdlGithub) {
    profiles.github = pdlGithub;
    addEnrichEvidence("github", pdlGithub, "pdl");
  }

  if (!profiles.twitter && pdlTwitter) {
    profiles.twitter = pdlTwitter;
    addEnrichEvidence("twitter", pdlTwitter, "pdl");
  }

  let canonicalLinkedinFromGithub: string | null = null;
  if (profiles.github) {
    let linkedinFromGithub = discoverLinkedinFromGithubSearchEvidence(profiles.github, allResults);
    if (!linkedinFromGithub) {
      linkedinFromGithub = await discoverLinkedinFromGithubProfile(profiles.github);
    }
    if (linkedinFromGithub) {
      const canonicalFromGithub = canonicalizeLinkedinProfileUrl(linkedinFromGithub);
      canonicalLinkedinFromGithub = canonicalFromGithub;
      const canonicalSelected = profiles.linkedin
        ? canonicalizeLinkedinProfileUrl(profiles.linkedin)
        : null;

      const hasLiteralIdentityCorroboration =
        profiles.linkedin &&
        hasLiteralIdentityLinkedinCorroboration(profiles.linkedin, allResults, input);

      const hasWeakSelectedLinkedin =
        Boolean(canonicalFromGithub && canonicalFromGithub !== canonicalSelected) &&
        Boolean(profiles.linkedin) &&
        !hasLiteralIdentityCorroboration;

      const shouldReplaceOrSet = !canonicalSelected || hasWeakSelectedLinkedin;

      if (shouldReplaceOrSet) {
        profiles.linkedin = linkedinFromGithub;
        enrichmentEvidence.push({
          url: linkedinFromGithub,
          platform: "linkedin",
          reason: "github-profile-linkedin-link",
          title: "LinkedIn discovered via selected GitHub profile",
        });
      }
    }
  }

  const selectedCanonicalLinkedin = profiles.linkedin
    ? canonicalizeLinkedinProfileUrl(profiles.linkedin)
    : null;
  const linkedinIsFromGithub = Boolean(
    selectedCanonicalLinkedin &&
    canonicalLinkedinFromGithub &&
    selectedCanonicalLinkedin === canonicalLinkedinFromGithub,
  );

  if (
    profiles.linkedin &&
    !pdlAnchoredLinkedin &&
    !linkedinIsFromGithub &&
    !hasStrongLinkedinCorroboration(profiles.linkedin, scoredResults, input) &&
    !hasNameCompanyLinkedinCorroboration(profiles.linkedin, scoredResults, input)
  ) {
    const weakLinkedin = profiles.linkedin;
    profiles.linkedin = null;
    enrichmentEvidence.push({
      url: weakLinkedin,
      platform: "linkedin",
      reason: "weak-linkedin-candidate",
      title: "LinkedIn candidate downgraded: no strong corroboration",
    });
  }

  let enrichCompanyCandidate: InferredCompany | null = null;
  let enrichLinkedinInsightsCandidate: LinkedinProfileInsights | null = null;

  const enrichLinkedinMatchesKnownCandidate = (linkedin: string | null): boolean => {
    if (!linkedin) return false;
    const target = canonicalizeLinkedinProfileUrl(linkedin);
    if (!target) return false;
    return linkedinCandidates.some(
      (candidate) => canonicalizeLinkedinProfileUrl(candidate) === target,
    );
  };

  const pdlCompanyCandidate = pdlEnrich?.company?.name
    ? {
        name: pdlEnrich.company.name,
        domain: pdlEnrich.company.domain?.toLowerCase() ?? null,
        confidence: Math.max(45, Math.min(100, Math.round(pdlEnrich.company.confidence ?? 72))),
        sources: [
          {
            type: "api-enrichment" as const,
            name: pdlEnrich.company.name,
            domain: pdlEnrich.company.domain?.toLowerCase() ?? null,
            url: "https://www.peopledatalabs.com",
            source: "pdl",
            matchedSignals: { name: true },
          },
        ],
      }
    : null;

  const pdlLinkedinInsightsCandidate =
    pdlEnrich?.linkedinInsights &&
    (pdlEnrich.linkedinInsights.company ||
      pdlEnrich.linkedinInsights.location ||
      pdlEnrich.linkedinInsights.experienceYears != null)
      ? {
          company: pdlEnrich.linkedinInsights.company ?? null,
          location: pdlEnrich.linkedinInsights.location ?? null,
          experienceYears: pdlEnrich.linkedinInsights.experienceYears ?? null,
          sourceUrl: pdlLinkedin ?? "https://www.peopledatalabs.com",
          sourceTier: "enrich" as const,
        }
      : null;

  let confidence = calculateConfidence(profiles, { emailFound });
  if (options?.enrichLookup) {
    hunterUsed = true;
    try {
      const enrich = await options.enrichLookup(input);
      if (enrich) {
        const linkedin = maybeCanonical(enrich.linkedin, "linkedin");
        const github = maybeCanonical(enrich.github, "github");
        const twitter = maybeCanonical(enrich.twitter, "twitter");

        const canPromoteLinkedinFromEnrich =
          !profiles.linkedin &&
          Boolean(linkedin) &&
          (linkedinCandidates.length === 0 || enrichLinkedinMatchesKnownCandidate(linkedin));

        if (canPromoteLinkedinFromEnrich && linkedin) {
          profiles.linkedin = linkedin;
          addEnrichEvidence("linkedin", linkedin, "hunter");
        }

        if (!profiles.github && github) {
          profiles.github = github;
          addEnrichEvidence("github", github, "hunter");
        }

        if (!profiles.twitter && twitter) {
          profiles.twitter = twitter;
          addEnrichEvidence("twitter", twitter, "hunter");
        }

        if (enrich.company?.name) {
          const emailDomain = getDomain(input.email ?? "");
          const enrichDomain = enrich.company.domain?.toLowerCase() ?? null;
          const domainMatched = Boolean(
            emailDomain &&
            enrichDomain &&
            (emailDomain === enrichDomain ||
              emailDomain.endsWith(`.${enrichDomain}`) ||
              enrichDomain.endsWith(`.${emailDomain}`)),
          );

          enrichCompanyCandidate = {
            name: enrich.company.name,
            domain: enrichDomain,
            confidence: Math.max(30, Math.min(100, Math.round(enrich.company.confidence ?? 55))),
            sources: [
              {
                type: "api-enrichment",
                name: enrich.company.name,
                domain: enrichDomain,
                url: "https://hunter.io",
                source: "hunter",
                matchedSignals: {
                  ...(domainMatched ? { emailDomain: true } : {}),
                },
              },
            ],
          };
        }

        const enrichInsights = enrich.linkedinInsights;
        if (
          enrichInsights &&
          (enrichInsights.company ||
            enrichInsights.location ||
            enrichInsights.experienceYears != null)
        ) {
          enrichLinkedinInsightsCandidate = {
            company: enrichInsights.company ?? null,
            location: enrichInsights.location ?? null,
            experienceYears: enrichInsights.experienceYears ?? null,
            sourceUrl: linkedin ?? "https://hunter.io",
            sourceTier: "enrich",
          };
        }
      }
    } catch {
      // Hunter lookup is additive; if it fails, preserve search-based results.
    }
  }

  confidence = calculateConfidence(profiles, { emailFound });
  const strongByPlatform = getStrongCandidatesByPlatform(
    scoredResults,
    { ...input, companyHint },
    5,
  );

  if (profiles.linkedin) {
    const selectedCanonical = canonicalizeLinkedinProfileUrl(profiles.linkedin);
    const hasSelectedStrongCorroborated = strongByPlatform.linkedin.some(
      (candidate) =>
        candidate.corroborated &&
        canonicalizeLinkedinProfileUrl(candidate.url) === selectedCanonical,
    );
    const conflictingStrongNonCorroborated = strongByPlatform.linkedin.filter(
      (candidate) =>
        !candidate.corroborated &&
        canonicalizeLinkedinProfileUrl(candidate.url) !== selectedCanonical,
    );

    if (
      !pdlAnchoredLinkedin &&
      !hasSelectedStrongCorroborated &&
      conflictingStrongNonCorroborated.length >= 2
    ) {
      const weakLinkedin = profiles.linkedin;
      profiles.linkedin = null;
      enrichmentEvidence.push({
        url: weakLinkedin,
        platform: "linkedin",
        reason: "weak-linkedin-candidate",
        title: "LinkedIn candidate downgraded: ambiguous stronger conflicting candidates",
      });
    }

    if (profiles.linkedin) {
      const conflictingNameAnchoredCandidates = countConflictingNameAnchoredLinkedinCandidates(
        profiles.linkedin,
        allResults,
        input.name,
      );

      if (
        !pdlAnchoredLinkedin &&
        selectedLinkedinLooksEmailOnlyCorroborated(profiles.linkedin, allResults, input) &&
        conflictingNameAnchoredCandidates >= 2
      ) {
        const weakLinkedin = profiles.linkedin;
        profiles.linkedin = null;
        enrichmentEvidence.push({
          url: weakLinkedin,
          platform: "linkedin",
          reason: "weak-linkedin-candidate",
          title:
            "LinkedIn candidate downgraded: email-only corroboration with conflicting name matches",
        });
      }
    }
  }

  const evidenceMap = new Map<string, EvidenceLink>();
  for (const item of enrichmentEvidence) {
    evidenceMap.set(item.url, item);
  }
  for (const item of buildEvidence(input, allResults, profiles)) {
    if (!evidenceMap.has(item.url)) {
      evidenceMap.set(item.url, item);
    }
  }
  const evidence = [...evidenceMap.values()].slice(0, 10);

  const strongCandidates = (["linkedin", "github", "twitter"] as const)
    .flatMap((platform) =>
      strongByPlatform[platform].map((candidate) => ({
        platform,
        url: candidate.url,
        score: candidate.score,
        corroborated: candidate.corroborated,
        evidence: evidence
          .filter(
            (item) =>
              item.platform === platform && normalizeUrl(item.url) === normalizeUrl(candidate.url),
          )
          .slice(0, 3)
          .map((item) => item.reason),
      })),
    )
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.corroborated !== right.corroborated) {
        return Number(right.corroborated) - Number(left.corroborated);
      }
      return left.url.localeCompare(right.url);
    });

  const { confidenceByPlatform, acceptedProfiles, candidateProfiles, rejectionReasons } =
    classifyProfiles(profiles, evidence, {
      linkedinCandidates,
      linkedinStrongCandidates: strongByPlatform.linkedin,
    });

  const linkedinInsightsFromAccepted = extractLinkedinInsightsFromAccepted(
    acceptedProfiles,
    allResults,
  );

  let linkedinInsightsFromSelectedProfile: LinkedinProfileInsights | null = null;
  if (!linkedinInsightsFromAccepted && profiles.linkedin) {
    linkedinInsightsFromSelectedProfile = await backfillLinkedinInsightsFromSelectedProfile({
      search,
      linkedinUrl: profiles.linkedin,
      input,
    });

    if (!linkedinInsightsFromSelectedProfile) {
      linkedinInsightsFromSelectedProfile = await fetchLinkedinInsightsFromProfileUrl(
        profiles.linkedin,
      );
    }
  }

  let linkedinInsightsFromStrongCandidate: LinkedinProfileInsights | null = null;
  if (
    !linkedinInsightsFromAccepted &&
    !linkedinInsightsFromSelectedProfile &&
    strongByPlatform.linkedin.length === 1
  ) {
    const singleStrong = strongByPlatform.linkedin[0];
    const fromCandidate = extractLinkedinInsightsFromAccepted(
      [{ platform: "linkedin", url: singleStrong.url }],
      allResults,
    );
    if (fromCandidate) {
      linkedinInsightsFromStrongCandidate = {
        ...fromCandidate,
        sourceTier: "candidate-linkedin",
      };
    }
  }

  const linkedinInsights =
    linkedinInsightsFromAccepted ??
    linkedinInsightsFromSelectedProfile ??
    pdlLinkedinInsightsCandidate ??
    linkedinInsightsFromStrongCandidate ??
    enrichLinkedinInsightsCandidate;

  const companyFromInsights = linkedinInsights?.company
    ? {
        name: linkedinInsights.company,
        domain: null,
        confidence:
          linkedinInsights.sourceTier === "accepted-linkedin"
            ? 45
            : linkedinInsights.sourceTier === "enrich"
              ? 40
              : 35,
        sources: [
          {
            type: "linkedin-profile" as const,
            name: linkedinInsights.company,
            domain: null,
            url: linkedinInsights.sourceUrl,
            source: linkedinInsights.sourceTier,
            matchedSignals: { name: true },
          },
        ],
      }
    : null;

  const inferredCompanyFromSearch = await inferCompanyFromLead(input, allResults, acceptedProfiles);
  let company: InferredCompany | null = null;
  let companyOrigin: "pdl" | "hunter" | "linkedin-insights" | "search-inference" | "none" = "none";

  if (pdlCompanyCandidate) {
    company = pdlCompanyCandidate;
    companyOrigin = "pdl";
  } else if (inferredCompanyFromSearch) {
    company = inferredCompanyFromSearch;
    companyOrigin = "search-inference";
  } else if (enrichCompanyCandidate) {
    company = enrichCompanyCandidate;
    companyOrigin = "hunter";
  } else if (companyFromInsights) {
    company = companyFromInsights;
    companyOrigin = "linkedin-insights";
  }

  const serperResults = allResults.filter((result) => result.sourceProvider === "serper").length;
  const tavilyResults = allResults.filter((result) => result.sourceProvider === "tavily").length;
  const pdlContributed = enrichmentEvidence.some((item) => item.reason === "pdl-lookup");
  const hunterContributed = enrichmentEvidence.some((item) => item.reason === "hunter-lookup");

  const linkedinOrigin = resolveProfileOrigin({
    platform: "linkedin",
    selectedUrl: profiles.linkedin,
    evidence: enrichmentEvidence,
  });
  const githubOrigin = resolveProfileOrigin({
    platform: "github",
    selectedUrl: profiles.github,
    evidence: enrichmentEvidence,
  }) as "pdl" | "hunter" | "search" | "none";
  const twitterOrigin = resolveProfileOrigin({
    platform: "twitter",
    selectedUrl: profiles.twitter,
    evidence: enrichmentEvidence,
  }) as "pdl" | "hunter" | "search" | "none";

  return {
    profiles,
    confidence,
    confidenceByPlatform,
    acceptedProfiles,
    strongCandidates,
    candidateProfiles,
    rejectionReasons,
    company,
    linkedinInsights,
    queriesRun: queries,
    evidence,
    providerSignals: {
      serperResults,
      tavilyResults,
      pdlUsed,
      pdlContributed,
      hunterUsed,
      hunterContributed,
    },
    resultOrigins: {
      linkedin: linkedinOrigin,
      github: githubOrigin,
      twitter: twitterOrigin,
      company: companyOrigin,
    },
    ...(options?.debug
      ? {
          debugSummary: {
            detectedCountryIso: queryBuild.detectedCountryIso,
            activatedDirectorySources: queryBuild.activatedDirectorySources,
          },
        }
      : {}),
    ...(options?.debug ? { queryDebug } : {}),
  };
}

// Normalize GitHub profile URLs to canonical form
function normalizeGithubProfileUrl(url: string): string | null {
  if (!url) return null;
  try {
    // Remove query params, fragments, trailing slashes, and force https
    let cleaned = url.trim()
      .replace(/^http:/, 'https:')
      .replace(/\?.*$/, '')
      .replace(/#.*/, '')
      .replace(/\/$/, '');
    // Match github.com/username only
    const match = cleaned.match(/^https?:\/\/(www\.)?github\.com\/([A-Za-z0-9_-]+)$/);
    return match ? `https://github.com/${match[2]}` : null;
  } catch {
    return null;
  }
}
