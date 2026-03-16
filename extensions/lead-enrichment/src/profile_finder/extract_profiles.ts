import { geoBoostFromText, geoConflictFromText, getCountryFromPhone } from "./geo_utils.js";

export type SearchResult = {
  url?: string;
  title?: string;
  description?: string;
  sourceQuery?: string;
  sourceProvider?: "serper" | "tavily";
  /** True when the search query that produced this result contained the input email. */
  fromEmailQuery?: boolean;
  /** True when the search query that produced this result contained the input phone. */
  fromPhoneQuery?: boolean;
};

export type SocialProfiles = {
  linkedin: string | null;
  github: string | null;
  twitter: string | null;
};

// Patterns that indicate a genuine profile page vs. a listing/search page.
const LINKEDIN_PROFILE_RE = /linkedin\.com\/in\/[\w%-]+/i;
const GITHUB_PROFILE_RE = /github\.com\/[\w-]+(?:\/[\w-]+)?/i;
const TWITTER_PROFILE_RE = /(?:twitter|x)\.com\/[\w]+/i;

// Paths that typically indicate non-profile pages to skip.
const GITHUB_SKIP_RE = /github\.com\/(search|explore|topics|collections|orgs)\b/i;
const TWITTER_SKIP_HANDLES = new Set(["search", "i", "home", "explore", "intent", "share"]);

type ExtractProfileInput = {
  name?: string;
  email?: string;
  phone?: string;
  companyHint?: string;
};

type Platform = keyof SocialProfiles;

type Candidate = {
  url: string;
  score: number;
  corroborated: boolean;
};

export type RankedCandidate = {
  url: string;
  score: number;
  corroborated: boolean;
};

type CandidateScore = {
  score: number;
  corroborated: boolean;
};

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeDigits(value: string | undefined): string {
  return (value ?? "").replace(/\D+/g, "");
}

function normalizeAlphaNum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getNameTokens(name: string | undefined): string[] {
  return normalizeText(name)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function getEmailLocalPart(email: string | undefined): string {
  const local = normalizeText(email).split("@")[0] ?? "";
  return local.replace(/[^a-z0-9]/g, "");
}

function longestCommonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let length = 0;
  while (length < max && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

function canonicalizeLinkedinUrl(url: string): string | null {
  const match = url.match(/linkedin\.com\/in\/([\w%-]+)/i);
  return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}` : null;
}

function canonicalizeGithubUrl(url: string): string | null {
  if (GITHUB_SKIP_RE.test(url)) {
    return null;
  }
  const match = url.match(/github\.com\/([\w-]+)/i);
  return match ? `https://github.com/${match[1]}` : null;
}

function canonicalizeTwitterUrl(url: string): string | null {
  const match = url.match(/(?:twitter|x)\.com\/([\w]+)/i);
  if (!match) {
    return null;
  }
  const handle = match[1].toLowerCase();
  if (TWITTER_SKIP_HANDLES.has(handle)) {
    return null;
  }
  return `https://twitter.com/${match[1]}`;
}

function getCanonicalUrl(platform: Platform, url: string): string | null {
  if (platform === "linkedin") {
    return canonicalizeLinkedinUrl(url);
  }
  if (platform === "github") {
    return canonicalizeGithubUrl(url);
  }
  return canonicalizeTwitterUrl(url);
}

function getPlatformHandle(platform: Platform, url: string): string {
  const canonical = getCanonicalUrl(platform, url) ?? "";
  return canonical.split("/").pop()?.toLowerCase() ?? "";
}

function queryTargetsPlatform(query: string, platform: Platform): boolean {
  const lower = normalizeText(query);
  if (platform === "linkedin") return lower.includes("site:linkedin.com/in");
  if (platform === "github") return lower.includes("site:github.com");
  return lower.includes("site:twitter.com") || lower.includes("site:x.com");
}

function scoreCandidate(
  platform: Platform,
  result: SearchResult,
  input?: ExtractProfileInput,
): CandidateScore {
  const url = result.url ?? "";
  const title = normalizeText(result.title);
  const description = normalizeText(result.description);
  const sourceQuery = normalizeText(result.sourceQuery);
  // haystack = only actual snippet content (NOT sourceQuery/URL text).
  // URL handles often contain numeric suffixes that can look like phone matches.
  const haystack = [title, description].join(" ");
  const handle = normalizeAlphaNum(getPlatformHandle(platform, url));
  const nameTokens = getNameTokens(input?.name);
  const fullName = normalizeText(input?.name);
  const compactFullName = normalizeAlphaNum(fullName);
  const email = normalizeText(input?.email);
  const phone = normalizeDigits(input?.phone);
  const emailLocalPart = getEmailLocalPart(input?.email);
  const companyHint = normalizeText(input?.companyHint);
  const compactCompanyHint = normalizeAlphaNum(companyHint);
  const compactHaystack = normalizeAlphaNum(haystack);
  const countryInfo = getCountryFromPhone(input?.phone);

  let score = 0;
  let corroborated = false;

  if (queryTargetsPlatform(sourceQuery, platform)) {
    score += 1;
  }

  if (fullName && (title.includes(fullName) || description.includes(fullName))) {
    score += 4;
  }

  if (compactFullName && handle && handle.includes(compactFullName)) {
    score += 4;
  }

  const nameHaystack = [title, description].join(" ");
  const matchedNameTokens = nameTokens.filter((token) => nameHaystack.includes(token));
  if (nameTokens.length >= 2 && matchedNameTokens.length === nameTokens.length) {
    score += 3;
  } else if (matchedNameTokens.length > 0) {
    score += Math.min(matchedNameTokens.length, 2);
  }

  const handleMatchedTokens = nameTokens.filter((token) => handle.includes(token));
  if (nameTokens.length >= 2 && handleMatchedTokens.length === nameTokens.length) {
    score += 2;
  } else if (handleMatchedTokens.length > 0) {
    score += 1;
  }

  const geo = geoBoostFromText(nameHaystack, countryInfo);
  if (geo.boost > 0) {
    score += Math.min(3, Math.round(geo.boost * 10));
  }

  const hasLiteralContactInSnippet = Boolean(
    (email && haystack.includes(email)) || (phone && haystack.includes(phone)),
  );
  const geoConflict = geoConflictFromText(nameHaystack, countryInfo);
  const hasGeoConflict = geoConflict.conflicts.length > 0;
  if (hasGeoConflict) {
    score -= 10;
  }

  const hasStrongNameAnchor =
    Boolean(fullName && (title.includes(fullName) || description.includes(fullName))) ||
    (nameTokens.length >= 2 && matchedNameTokens.length === nameTokens.length) ||
    (nameTokens.length >= 2 && handleMatchedTokens.length === nameTokens.length) ||
    Boolean(compactFullName && handle && handle.includes(compactFullName));

  // Email found literally in the result content (strongest signal).
  if (email && haystack.includes(email)) {
    score += 12;
    corroborated = true;
  }

  // Phone found literally in the result content.
  if (phone && haystack.includes(phone)) {
    score += 12;
    corroborated = true;
  }

  // Company corroboration for LinkedIn: requires full-name phrase + company
  // phrase together in result content (safe promotion for common-name leads).
  if (platform === "linkedin" && companyHint && companyHint.length > 3) {
    const companyMatched =
      haystack.includes(companyHint) ||
      (compactCompanyHint.length >= 4 && compactHaystack.includes(compactCompanyHint));
    const fullNameMatched =
      (fullName && haystack.includes(fullName)) ||
      (compactFullName.length >= 4 && compactHaystack.includes(compactFullName));

    if (Boolean(fullNameMatched) && companyMatched) {
      score += 8;
      corroborated = true;
    } else if (companyMatched) {
      score += 4;
    }
  }

  // The search engine returned this result for an email/phone query targeting this platform.
  // That means the search engine itself linked the email/phone to this profile — corroboration.
  if (result.fromEmailQuery && queryTargetsPlatform(sourceQuery, platform)) {
    if (!hasGeoConflict || hasLiteralContactInSnippet) {
      score += 8;
    }
    // Prevent false positives from broad provider matches: require a strong
    // name anchor (or literal email match handled above) before corroborating.
    corroborated ||= hasStrongNameAnchor && (!hasGeoConflict || hasLiteralContactInSnippet);
  }

  if (result.fromPhoneQuery && queryTargetsPlatform(sourceQuery, platform)) {
    if (!hasGeoConflict || hasLiteralContactInSnippet) {
      score += 8;
    }
    corroborated ||= hasStrongNameAnchor && (!hasGeoConflict || hasLiteralContactInSnippet);
  }

  if (emailLocalPart && handle) {
    const handleDigits = handle.match(/\d+/)?.[0] ?? "";
    const emailDigits = emailLocalPart.match(/\d+/)?.[0] ?? "";

    if (handle === emailLocalPart) {
      score += 10;
      corroborated = true;
    } else if (handle.includes(emailLocalPart) || emailLocalPart.includes(handle)) {
      score += 6;
      const lenDiff = Math.abs(handle.length - emailLocalPart.length);
      const hasMatchingDigits = handleDigits && emailDigits && handleDigits === emailDigits;
      if (lenDiff <= 2 || hasMatchingDigits) {
        corroborated = true;
      }
    } else {
      const prefix = longestCommonPrefixLength(handle, emailLocalPart);
      if (prefix >= 5) {
        score += 3;
      }

      if (handleDigits && emailDigits && handleDigits === emailDigits) {
        score += 2;
        corroborated ||= platform === "github";
      }
    }
  }

  return { score, corroborated };
}

const thresholdByPlatform: Record<Platform, number> = {
  linkedin: 12,
  github: 11,
  twitter: 11,
};

const STRONG_SCORE_WITHOUT_CORROBORATION = 30;

function rankCandidates(
  platform: Platform,
  results: SearchResult[],
  input?: ExtractProfileInput,
): Candidate[] {
  const candidates = new Map<string, Candidate>();

  for (const result of results) {
    const canonicalUrl = getCanonicalUrl(platform, result.url ?? "");
    if (!canonicalUrl) {
      continue;
    }

    const nextScore = scoreCandidate(platform, result, input);
    const current = candidates.get(canonicalUrl);
    if (current) {
      current.score += nextScore.score;
      current.corroborated ||= nextScore.corroborated;
      continue;
    }

    candidates.set(canonicalUrl, {
      url: canonicalUrl,
      score: nextScore.score,
      corroborated: nextScore.corroborated,
    });
  }

  return [...candidates.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.corroborated !== right.corroborated) {
      return Number(right.corroborated) - Number(left.corroborated);
    }
    return left.url.localeCompare(right.url);
  });
}

function isStrictAccepted(platform: Platform, candidate: Candidate): boolean {
  if (candidate.score < thresholdByPlatform[platform]) {
    return false;
  }
  if (!candidate.corroborated) {
    return false;
  }
  return true;
}

function isStrongCandidate(platform: Platform, candidate: Candidate): boolean {
  if (candidate.corroborated && candidate.score >= thresholdByPlatform[platform]) {
    return true;
  }
  if (!candidate.corroborated && candidate.score >= STRONG_SCORE_WITHOUT_CORROBORATION) {
    return true;
  }
  return false;
}

export function getStrongCandidatesByPlatform(
  results: SearchResult[],
  input?: ExtractProfileInput,
  maxPerPlatform = 5,
): Record<Platform, RankedCandidate[]> {
  const max = Math.max(1, Math.floor(maxPerPlatform));
  const platforms: Platform[] = ["linkedin", "github", "twitter"];
  const byPlatform = {
    linkedin: [] as RankedCandidate[],
    github: [] as RankedCandidate[],
    twitter: [] as RankedCandidate[],
  };

  for (const platform of platforms) {
    const ranked = rankCandidates(platform, results, input)
      .filter((candidate) => isStrongCandidate(platform, candidate))
      .slice(0, max)
      .map((candidate) => ({
        url: candidate.url,
        score: candidate.score,
        corroborated: candidate.corroborated,
      }));
    byPlatform[platform] = ranked;
  }

  return byPlatform;
}

function selectBestCandidate(
  platform: Platform,
  results: SearchResult[],
  input?: ExtractProfileInput,
): string | null {
  const ranked = rankCandidates(platform, results, input);
  const accepted = ranked.find((candidate) => isStrictAccepted(platform, candidate));
  return accepted?.url ?? null;
}

/**
 * Extract the best-matching social profile URL for each platform from a list
 * of search results. Returns null for any platform not found.
 */
export function extractProfiles(
  results: SearchResult[],
  input?: ExtractProfileInput,
): SocialProfiles {
  if (!input?.name && !input?.email && !input?.phone) {
    const fallbackProfiles: SocialProfiles = {
      linkedin: null,
      github: null,
      twitter: null,
    };

    for (const result of results) {
      const url = result.url ?? "";

      if (!fallbackProfiles.linkedin && LINKEDIN_PROFILE_RE.test(url)) {
        fallbackProfiles.linkedin = canonicalizeLinkedinUrl(url);
      }

      if (!fallbackProfiles.github && GITHUB_PROFILE_RE.test(url) && !GITHUB_SKIP_RE.test(url)) {
        fallbackProfiles.github = canonicalizeGithubUrl(url);
      }

      if (!fallbackProfiles.twitter && TWITTER_PROFILE_RE.test(url)) {
        fallbackProfiles.twitter = canonicalizeTwitterUrl(url);
      }

      if (fallbackProfiles.linkedin && fallbackProfiles.github && fallbackProfiles.twitter) {
        break;
      }
    }

    return fallbackProfiles;
  }

  return {
    linkedin: selectBestCandidate("linkedin", results, input),
    github: selectBestCandidate("github", results, input),
    twitter: selectBestCandidate("twitter", results, input),
  };
}

/**
 * Compute a confidence score (0–1) based on which profiles were found.
 *
 * Weights:
 *   linkedin  → +0.4  (most informative for professional identity)
 *   github    → +0.3
 *   twitter   → +0.2
 *   (reserved → +0.1 for email/phone confirmation, applied in find_profiles)
 */
export function calculateConfidence(
  profiles: SocialProfiles,
  extras?: { emailFound?: boolean },
): number {
  let score = 0;
  if (profiles.linkedin) score += 0.4;
  if (profiles.github) score += 0.3;
  if (profiles.twitter) score += 0.2;
  if (extras?.emailFound) score += 0.1;
  return Math.round(score * 100) / 100;
}
