import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { findProfiles } from "./find_profiles.js";
import type { EnrichLookupFn, SearchResult, WebSearchFn } from "./find_profiles.js";
import { getDomain } from "./company_inference.js";
import { getCountryFromPhone } from "./geo_utils.js";

const SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search";
const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const HUNTER_DEFAULT_ENDPOINT = "https://api.hunter.io/v2/people/find";
const PDL_DEFAULT_ENDPOINT = "https://api.peopledatalabs.com/v5/person/enrich";
const DEFAULT_RESULT_COUNT = 5;
const PDL_LOOKUP_TIMEOUT_MS = 12_000;
const PDL_MAX_RETRIES = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return null;

  const asSeconds = Number(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const asDate = Date.parse(retryAfter);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    if (delta > 0) return delta;
  }

  return null;
}

async function formatHttpError(prefix: string, response: Response): Promise<string> {
  let detail = "";
  try {
    const raw = (await response.text()).trim();
    if (raw) {
      const compact = raw.replace(/\s+/g, " ").trim();
      detail = compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
    }
  } catch {
    // Ignore body read failures and keep status-only error.
  }

  return `${prefix}: ${response.status} ${response.statusText}${detail ? ` | ${detail}` : ""}`;
}

type SerperSearchResult = {
  title?: string;
  link?: string;
  snippet?: string;
};

type SerperSearchResponse = {
  organic?: SerperSearchResult[];
};

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
};

type TavilySearchResponse = {
  results?: TavilySearchResult[];
};

/**
 * Build a WebSearchFn backed by the Serper Search API.
 */
function createSerperSearchFn(apiKey: string): WebSearchFn {
  return async (query: string, count = DEFAULT_RESULT_COUNT): Promise<SearchResult[]> => {
    const response = await fetch(SERPER_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        q: query,
        num: Math.min(count, 10),
      }),
    });

    if (!response.ok) {
      throw new Error(await formatHttpError("Serper Search error", response));
    }

    const data = (await response.json()) as SerperSearchResponse;
    return (data.organic ?? []).map((r) => ({
      url: r.link,
      title: r.title,
      description: r.snippet,
      sourceProvider: "serper",
    }));
  };
}

function createTavilySearchFn(apiKey: string): WebSearchFn {
  return async (query: string, count = DEFAULT_RESULT_COUNT): Promise<SearchResult[]> => {
    const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: Math.min(count, 10),
      }),
    });

    if (!response.ok) {
      throw new Error(await formatHttpError("Tavily Search error", response));
    }

    const data = (await response.json()) as TavilySearchResponse;
    return (data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title,
      description: r.content,
      sourceProvider: "tavily",
    }));
  };
}

type SearchProvider = {
  name: "serper" | "tavily";
  search: WebSearchFn;
};

function readString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined;
}

function pickFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = readString(value);
    if (candidate) return candidate;
  }
  return undefined;
}

function getEnrichPerson(data: unknown): Record<string, unknown> | null {
  if (data == null || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const person =
    (root.person as Record<string, unknown> | undefined) ??
    (root.data as Record<string, unknown> | undefined) ??
    root;
  return person;
}

function toNameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function hasStrongNameOverlap(inputName: string, enrichName: string): boolean {
  const inputTokens = toNameTokens(inputName);
  const enrichTokens = new Set(toNameTokens(enrichName));
  if (inputTokens.length === 0 || enrichTokens.size === 0) return false;

  const overlap = inputTokens.filter((token) => enrichTokens.has(token)).length;
  if (inputTokens.length >= 3) return overlap >= 2;
  if (inputTokens.length === 2) return overlap === 2;
  return overlap >= 1;
}

function normalizeCountry(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function countriesMatch(left: string, right: string): boolean {
  const leftNorm = normalizeCountry(left);
  const rightNorm = normalizeCountry(right);
  if (!leftNorm || !rightNorm) return false;
  return leftNorm === rightNorm || leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm);
}

function normalizeEnrichResponse(data: unknown): {
  linkedin?: string;
  github?: string;
  twitter?: string;
  facebook?: string;
  jobTitle?: string;
  industry?: string;
  emails?: string[];
  company?: { name?: string; domain?: string; confidence?: number };
  linkedinInsights?: { company?: string; location?: string; experienceYears?: number };
} | null {
  const person = getEnrichPerson(data);
  if (!person) return null;

  const linkedin = pickFirstString(
    person.linkedin,
    person.linkedin_url,
    (person.profile as Record<string, unknown> | undefined)?.linkedin,
  );
  const github = pickFirstString(
    person.github,
    person.github_url,
    (person.profile as Record<string, unknown> | undefined)?.github,
  );
  const twitter = pickFirstString(
    person.twitter,
    person.twitter_url,
    person.x,
    person.x_url,
    (person.profile as Record<string, unknown> | undefined)?.twitter,
  );
  const facebook = pickFirstString(
    person.facebook,
    person.facebook_url,
    (person.profile as Record<string, unknown> | undefined)?.facebook,
  );
  const jobTitle = pickFirstString(person.job_title, person.job_title_role, person.title);
  const industry = pickFirstString(person.industry, person.job_company_industry);
  const emails = Array.isArray(person.emails)
    ? person.emails.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];

  const companyObj = (person.company as Record<string, unknown> | undefined) ?? {};
  const companyName = pickFirstString(companyObj.name, person.company_name, person.company);
  const companyDomain = pickFirstString(
    companyObj.domain,
    person.company_domain,
    person.company_website,
  );
  const rawConfidence =
    typeof companyObj.confidence === "number"
      ? companyObj.confidence
      : typeof person.company_confidence === "number"
        ? person.company_confidence
        : undefined;

  const employmentObj = (person.employment as Record<string, unknown> | undefined) ?? {};
  const enrichCompanyFromEmployment = pickFirstString(
    employmentObj.company,
    employmentObj.company_name,
    person.current_company,
  );

  const city = pickFirstString(person.city);
  const region = pickFirstString(person.state, person.region);
  const country = pickFirstString(person.country, person.country_name);
  const location = pickFirstString(
    person.location,
    person.location_name,
    [city, region, country].filter(Boolean).join(", "),
  );

  const rawYearsExperience =
    typeof person.years_experience === "number"
      ? person.years_experience
      : typeof person.experience_years === "number"
        ? person.experience_years
        : undefined;

  if (
    !linkedin &&
    !github &&
    !twitter &&
    !facebook &&
    !jobTitle &&
    !industry &&
    emails.length === 0 &&
    !companyName &&
    !companyDomain &&
    !enrichCompanyFromEmployment &&
    !location &&
    rawYearsExperience === undefined
  ) {
    return null;
  }

  return {
    linkedin,
    github,
    twitter,
    ...(facebook ? { facebook } : {}),
    ...(jobTitle ? { jobTitle } : {}),
    ...(industry ? { industry } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(companyName || companyDomain
      ? {
          company: {
            ...(companyName ? { name: companyName } : {}),
            ...(companyDomain ? { domain: companyDomain } : {}),
            ...(typeof rawConfidence === "number" ? { confidence: rawConfidence } : {}),
          },
        }
      : {}),
    ...(enrichCompanyFromEmployment || location || typeof rawYearsExperience === "number"
      ? {
          linkedinInsights: {
            ...(enrichCompanyFromEmployment ? { company: enrichCompanyFromEmployment } : {}),
            ...(location ? { location } : {}),
            ...(typeof rawYearsExperience === "number"
              ? { experienceYears: rawYearsExperience }
              : {}),
          },
        }
      : {}),
  };
}

export function createEnrichLookupFn(options: {
  hunterApiKey: string;
  hunterApiUrl?: string;
}): EnrichLookupFn {
  const endpoint = options.hunterApiUrl?.trim() || HUNTER_DEFAULT_ENDPOINT;

  return async (input) => {
    // Hunter people/find requires email.
    if (!input.email) return null;
    if (!getDomain(input.email)) return null;

    const requestUrl = new URL(endpoint);
    requestUrl.searchParams.set("email", input.email);
    requestUrl.searchParams.set("api_key", options.hunterApiKey);

    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(await formatHttpError("Hunter lookup error", response));
    }

    const data = (await response.json()) as unknown;
    const normalized = normalizeEnrichResponse(data);
    if (!normalized) return null;

    const person = getEnrichPerson(data);
    const enrichName = pickFirstString(person?.name, person?.full_name);
    const enrichCountry = pickFirstString(person?.country, person?.country_name);
    const inputCountry = getCountryFromPhone(input.phone)?.country;

    const nameCheckPassed = enrichName ? hasStrongNameOverlap(input.name, enrichName) : true;
    const countryCheckPassed =
      inputCountry && enrichCountry ? countriesMatch(inputCountry, enrichCountry) : true;

    if (!nameCheckPassed && !countryCheckPassed) {
      return null;
    }

    return normalized;
  };
}

export function createPdlLookupFn(options: {
  pdlApiKey: string;
  pdlApiUrl?: string;
}): EnrichLookupFn {
  const endpoint = options.pdlApiUrl?.trim() || PDL_DEFAULT_ENDPOINT;

  return async (input) => {
    const requestUrl = new URL(endpoint);

    if (input.email) requestUrl.searchParams.set("email", input.email);
    if (input.name) requestUrl.searchParams.set("name", input.name);
    if (input.phone) requestUrl.searchParams.set("phone", input.phone);

    const countryInfo = getCountryFromPhone(input.phone);
    if (countryInfo?.country) {
      requestUrl.searchParams.set("location_country", countryInfo.country);
    }

    let response: Response | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= PDL_MAX_RETRIES; attempt += 1) {
      try {
        response = await fetch(requestUrl, {
          method: "GET",
          headers: {
            "X-Api-Key": options.pdlApiKey,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(PDL_LOOKUP_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error;
        if (attempt >= PDL_MAX_RETRIES) {
          throw error;
        }
        await delay(300 * 2 ** attempt);
        continue;
      }

      if (response.status === 404) {
        return null;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= PDL_MAX_RETRIES) {
          break;
        }
        const retryAfterMs = parseRetryAfterMs(response) ?? 400 * 2 ** attempt;
        await delay(Math.min(retryAfterMs, 5000));
        continue;
      }

      break;
    }

    if (!response) {
      throw lastError instanceof Error ? lastError : new Error("People Data Labs lookup failed");
    }

    if (!response.ok) {
      throw new Error(await formatHttpError("People Data Labs lookup error", response));
    }

    const data = (await response.json()) as unknown;
    const normalized = normalizeEnrichResponse(data);
    if (!normalized) return null;

    const person = getEnrichPerson(data);
    const enrichName = pickFirstString(person?.name, person?.full_name);
    const enrichCountry = pickFirstString(
      person?.country,
      person?.country_name,
      person?.location_country,
      person?.job_company_location_country,
    );
    const inputCountry = getCountryFromPhone(input.phone)?.country;

    const nameCheckPassed = enrichName ? hasStrongNameOverlap(input.name, enrichName) : true;
    const countryCheckPassed =
      inputCountry && enrichCountry ? countriesMatch(inputCountry, enrichCountry) : true;

    if (!nameCheckPassed && !countryCheckPassed) {
      return null;
    }

    return normalized;
  };
}

function normalizeUrlForDedup(url: string | undefined): string {
  return (url ?? "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function createProfileSearchFn(options: {
  serperApiKey?: string;
  tavilyApiKey?: string;
}): WebSearchFn {
  const providers: SearchProvider[] = [];

  if (options.serperApiKey) {
    providers.push({
      name: "serper",
      search: createSerperSearchFn(options.serperApiKey),
    });
  }

  if (options.tavilyApiKey) {
    providers.push({
      name: "tavily",
      search: createTavilySearchFn(options.tavilyApiKey),
    });
  }

  if (providers.length === 0) {
    throw new Error("No search provider configured. Set SERPER_API_KEY or TAVILY_API_KEY.");
  }

  return async (query: string, count = DEFAULT_RESULT_COUNT): Promise<SearchResult[]> => {
    const errors: string[] = [];
    const merged: SearchResult[] = [];
    const seen = new Set<string>();

    for (const provider of providers) {
      try {
        const results = await provider.search(query, count);
        for (const result of results) {
          const key = normalizeUrlForDedup(result.url);
          if (!key || seen.has(key)) {
            continue;
          }
          seen.add(key);
          merged.push(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider.name}: ${message}`);
      }
    }

    if (errors.length === providers.length) {
      throw new Error(`All search providers failed (${errors.join(" | ")})`);
    }

    return merged;
  };
}

const FindProfilesSchema = Type.Object({
  name: Type.String({ description: "Full name of the person to look up." }),
  email: Type.Optional(Type.String({ description: "Email address (improves accuracy)." })),
  phone: Type.Optional(Type.String({ description: "Phone number (improves accuracy)." })),
});

type FindProfilesParams = Static<typeof FindProfilesSchema>;

/**
 * Create the find-profiles agent tool.
 *
 * @param options - Search provider API keys.
 */
export function createFindProfilesTool(options: {
  serperApiKey?: string;
  tavilyApiKey?: string;
  pdlApiKey?: string;
  pdlApiUrl?: string;
  hunterApiKey?: string;
  hunterApiUrl?: string;
}): AnyAgentTool {
  const search = createProfileSearchFn(options);
  const pdlLookup = options.pdlApiKey
    ? createPdlLookupFn({
        pdlApiKey: options.pdlApiKey,
        pdlApiUrl: options.pdlApiUrl,
      })
    : undefined;
  const enrichLookup = options.hunterApiKey
    ? createEnrichLookupFn({
        hunterApiKey: options.hunterApiKey,
        hunterApiUrl: options.hunterApiUrl,
      })
    : undefined;

  return {
    name: "find_profiles",
    label: "Find Social Profiles",
    description:
      "Discover LinkedIn, GitHub, and Twitter/X profiles for a person using their name, email, or phone number. Returns URLs and a confidence score.",
    parameters: FindProfilesSchema,
    async execute(_toolCallId: string, params: FindProfilesParams) {
      const result = await findProfiles(
        { name: params.name, email: params.email, phone: params.phone },
        search,
        {
          pdlLookup,
          enrichLookup,
        },
      );

      const text = JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        details: result,
      };
    },
  };
}
