export type CountryInfo = {
  iso: string;
  country: string;
  sampleCities?: string[];
};

export const PHONE_PREFIX_TO_COUNTRY: Record<string, CountryInfo> = {
  "91": { iso: "IN", country: "India", sampleCities: ["Bengaluru", "Delhi", "Mumbai", "Chennai"] },
  "60": {
    iso: "MY",
    country: "Malaysia",
    sampleCities: ["Kuala Lumpur", "Selangor", "Johor Bahru"],
  },
  "65": {
    iso: "SG",
    country: "Singapore",
    sampleCities: ["Singapore"],
  },
  "971": {
    iso: "AE",
    country: "United Arab Emirates",
    sampleCities: ["Dubai", "Abu Dhabi"],
  },
  "1": {
    iso: "US",
    country: "United States",
    sampleCities: ["New York", "San Francisco", "Seattle"],
  },
  "44": { iso: "GB", country: "United Kingdom", sampleCities: ["London", "Manchester"] },
};

export function getCountryFromPhone(phoneRaw?: string): ({ prefix: string } & CountryInfo) | null {
  if (!phoneRaw) return null;

  const normalized = phoneRaw.trim();
  const digitsOnly = normalized.replace(/\D/g, "");

  const prefixes = Object.keys(PHONE_PREFIX_TO_COUNTRY).sort(
    (left, right) => right.length - left.length,
  );

  const e164Candidate = normalized.startsWith("+") || normalized.startsWith("00") ? digitsOnly : "";

  for (const prefix of prefixes) {
    if (e164Candidate.startsWith(prefix)) {
      return { prefix, ...PHONE_PREFIX_TO_COUNTRY[prefix] };
    }
  }

  // Fallback: tolerate common non-E.164 local/plain mobile formats.
  // Malaysia numbers are frequently supplied as either:
  // - 60XXXXXXXXX (missing leading +)
  // - 01XXXXXXXX (local trunk format)
  if (digitsOnly.startsWith("60") && digitsOnly.length >= 10 && digitsOnly.length <= 12) {
    return { prefix: "60", ...PHONE_PREFIX_TO_COUNTRY["60"] };
  }

  if (/^01\d{7,9}$/.test(digitsOnly)) {
    return { prefix: "60", ...PHONE_PREFIX_TO_COUNTRY["60"] };
  }

  // Some CSV exports drop the local leading 0 and keep Malaysian mobile numbers
  // as 1XXXXXXXX or 11XXXXXXXX.
  if (/^1\d{7,9}$/.test(digitsOnly)) {
    return { prefix: "60", ...PHONE_PREFIX_TO_COUNTRY["60"] };
  }

  return null;
}

export function geoQueriesForName(name: string, countryInfo?: CountryInfo | null): string[] {
  if (!countryInfo) return [];

  const queries = [`"${name}" "${countryInfo.country}" site:linkedin.com/in`];
  if (countryInfo.sampleCities?.length) {
    queries.push(`"${name}" "${countryInfo.sampleCities[0]}" site:linkedin.com/in`);
  }
  return queries;
}

export function geoBoostFromText(
  text: string,
  countryInfo?: CountryInfo | null,
): {
  boost: number;
  matches: string[];
} {
  if (!text || !countryInfo) return { boost: 0, matches: [] };

  const lower = text.toLowerCase();
  let boost = 0;
  const matches: string[] = [];

  if (lower.includes(countryInfo.country.toLowerCase())) {
    boost += 0.12;
    matches.push(countryInfo.country);
  }

  if (countryInfo.sampleCities?.length) {
    for (const city of countryInfo.sampleCities) {
      if (lower.includes(city.toLowerCase())) {
        boost += 0.1;
        matches.push(city);
        break;
      }
    }
  }

  return { boost, matches };
}

export function geoConflictFromText(
  text: string,
  countryInfo?: CountryInfo | null,
): {
  conflicts: string[];
} {
  if (!text || !countryInfo) return { conflicts: [] };

  const lower = text.toLowerCase();
  const expected = new Set<string>([
    countryInfo.country.toLowerCase(),
    ...(countryInfo.sampleCities ?? []).map((city) => city.toLowerCase()),
  ]);

  const conflicts: string[] = [];
  for (const other of Object.values(PHONE_PREFIX_TO_COUNTRY)) {
    if (other.iso === countryInfo.iso) continue;

    if (lower.includes(other.country.toLowerCase())) {
      conflicts.push(other.country);
      continue;
    }

    for (const city of other.sampleCities ?? []) {
      const cityLower = city.toLowerCase();
      if (!expected.has(cityLower) && lower.includes(cityLower)) {
        conflicts.push(city);
        break;
      }
    }
  }

  return { conflicts };
}
