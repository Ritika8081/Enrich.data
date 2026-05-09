import { describe, expect, it, vi } from "vitest";
import {
  buildBusinessDirectoryQueries,
  extractLinkedinInsightsFromAccepted,
  extractCompanyFromSearchResults,
  getDomain,
  inferCompanyFromLead,
  normalizeCompanyName,
  scoreCompanyEvidence,
} from "./company_inference.js";
import type { CompanyEvidence } from "./company_inference.js";
import { calculateConfidence, extractProfiles } from "./extract_profiles.js";
import { findProfiles } from "./find_profiles.js";
import type { SearchResult, WebSearchFn } from "./find_profiles.js";
import {
  geoBoostFromText,
  geoConflictFromText,
  geoQueriesForName,
  getCountryFromPhone,
} from "./geo_utils.js";
import { createEnrichLookupFn, createPdlLookupFn } from "./tool.js";

describe("geo utils", () => {
  it("parses +91 country prefix", () => {
    const country = getCountryFromPhone("+919876543210");
    expect(country?.prefix).toBe("91");
    expect(country?.country).toBe("India");
  });

  it("parses +60 country prefix", () => {
    const country = getCountryFromPhone("+60123456789");
    expect(country?.prefix).toBe("60");
    expect(country?.iso).toBe("MY");
    expect(country?.country).toBe("Malaysia");
  });

  it("parses Malaysia number without plus prefix", () => {
    const country = getCountryFromPhone("60182345678");
    expect(country?.prefix).toBe("60");
    expect(country?.iso).toBe("MY");
  });

  it("parses Malaysia local mobile format", () => {
    const country = getCountryFromPhone("0177710325");
    expect(country?.prefix).toBe("60");
    expect(country?.iso).toBe("MY");
  });

  it("parses Malaysia local mobile format without leading zero", () => {
    const country = getCountryFromPhone("146209880");
    expect(country?.prefix).toBe("60");
    expect(country?.iso).toBe("MY");
  });

  it("builds geo-enriched queries", () => {
    const queries = geoQueriesForName("Apoorv Spandan", {
      iso: "IN",
      country: "India",
      sampleCities: ["Bengaluru"],
    });
    expect(queries).toContain('"Apoorv Spandan" "India" site:linkedin.com/in');
  });

  it("detects geo matches from snippet text", () => {
    const geo = geoBoostFromText("Apoorv Spandan - Bengaluru, India", {
      iso: "IN",
      country: "India",
      sampleCities: ["Bengaluru"],
    });
    expect(geo.boost).toBeGreaterThan(0);
    expect(geo.matches).toContain("Bengaluru");
  });

  it("detects geo conflicts from snippet text", () => {
    const geo = geoConflictFromText("San Francisco Bay Area, United States", {
      iso: "MY",
      country: "Malaysia",
      sampleCities: ["Kuala Lumpur"],
    });
    expect(geo.conflicts.length).toBeGreaterThan(0);
    expect(geo.conflicts.join(" ")).toMatch(/San Francisco|United States/);
  });
});

describe("extractProfiles", () => {
  it("extracts first-match URLs in fallback mode (no identity input)", () => {
    const results: SearchResult[] = [
      { url: "https://www.linkedin.com/in/hazibah-mustapha", title: "Hazibah Mustapha" },
      { url: "https://github.com/hazibah" },
      { url: "https://x.com/hazibah_dev" },
    ];
    const profiles = extractProfiles(results);
    expect(profiles.linkedin).toBe("https://www.linkedin.com/in/hazibah-mustapha");
    expect(profiles.github).toBe("https://github.com/hazibah");
    expect(profiles.twitter).toBe("https://twitter.com/hazibah_dev");
  });

  it("prefers github candidate corroborated by email-local-part overlap", () => {
    const results: SearchResult[] = [
      {
        url: "https://github.com/randomritika",
        title: "randomritika · GitHub",
        sourceQuery: '"Ritika Mishra" site:github.com',
      },
      {
        url: "https://github.com/Ritika8081",
        title: "Ritika8081 · GitHub",
        description: "Ritika Mishra profile",
        sourceQuery: '"ritikamis8081@gmail.com" site:github.com',
      },
    ];

    const profiles = extractProfiles(results, {
      name: "Ritika Mishra",
      email: "ritikamis8081@gmail.com",
    });

    expect(profiles.github).toBe("https://github.com/Ritika8081");
  });

  it("returns null for ambiguous common-name linkedin/twitter without corroboration", () => {
    const results: SearchResult[] = [
      {
        url: "https://www.linkedin.com/in/pranav-jha-a8a22431",
        title: "Pranav Jha - LinkedIn",
        description: "Software engineer profile",
        sourceQuery: '"Pranav Jha" site:linkedin.com/in',
      },
      {
        url: "https://twitter.com/pranavinc",
        title: "Pranav Jha (@pranavinc) / X",
        description: "Tech, startups, and code.",
        sourceQuery: '"Pranav Jha" site:twitter.com',
      },
    ];

    const profiles = extractProfiles(results, {
      name: "Pranav Jha",
      email: "pranavjhacoc@gmail.com",
      phone: "919453468991",
    });

    expect(profiles.linkedin).toBeNull();
    expect(profiles.twitter).toBeNull();
  });

  it("returns null for ambiguous github common-name matches without corroboration", () => {
    const results: SearchResult[] = [
      {
        url: "https://github.com/Jha-Pranav",
        title: "Jha-Pranav · GitHub",
        description: "Pranav Jha repositories",
        sourceQuery: '"Pranav Jha" site:github.com',
      },
    ];

    const profiles = extractProfiles(results, {
      name: "Pranav Jha",
      email: "pranavjhacoc@gmail.com",
      phone: "919453468991",
    });

    expect(profiles.github).toBeNull();
  });

  it("selects corroborated linkedin when email appears in result metadata", () => {
    const results: SearchResult[] = [
      {
        url: "https://www.linkedin.com/in/ritika-mishra-1234",
        title: "Ritika Mishra | LinkedIn",
        description: "Contact: ritikamis8081@gmail.com",
        sourceQuery: '"ritikamis8081@gmail.com" site:linkedin.com/in',
      },
    ];

    const profiles = extractProfiles(results, {
      name: "Ritika Mishra",
      email: "ritikamis8081@gmail.com",
    });

    expect(profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-1234");
  });

  it("treats linkedin profile handles case-insensitively", () => {
    const results: SearchResult[] = [
      {
        url: "https://www.linkedin.com/in/Ritika-Mishra-1234",
        title: "Ritika Mishra | LinkedIn",
        description: "Contact: ritikamis8081@gmail.com",
        sourceQuery: '"ritikamis8081@gmail.com" site:linkedin.com/in',
      },
    ];

    const profiles = extractProfiles(results, {
      name: "Ritika Mishra",
      email: "ritikamis8081@gmail.com",
    });

    expect(profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-1234");
  });

  it("corroborates linkedin from full name + company hint for business emails", () => {
    const results: SearchResult[] = [
      {
        url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a",
        title: "Choudhary Himanshu - Full Stack Developer at Fixit | LinkedIn",
        description: "Bengaluru, Karnataka, India",
        sourceQuery: '"Choudhary Himanshu" site:linkedin.com/in',
      },
    ];

    const profiles = extractProfiles(results, {
      name: "Choudhary Himanshu",
      email: "choudhary.himanshu@fix-it.ai",
      companyHint: "fix it",
    });

    expect(profiles.linkedin).toBe("https://www.linkedin.com/in/choudhary-himanshu-60615625a");
  });

  it("keeps conservative behavior across sample common-name handles", () => {
    const sampleHandles = [
      "pranavjha",
      "jha-pranav",
      "pranav-dev",
      "pranav-jha-123",
      "pjha",
      "pranavjha17",
      "pranav-j",
      "jha007",
      "pranav-kumar",
      "pranavcoc",
    ];

    for (const handle of sampleHandles) {
      const profiles = extractProfiles(
        [
          {
            url: `https://github.com/${handle}`,
            title: `${handle} · GitHub`,
            sourceQuery: '"Pranav Jha" site:github.com',
          },
        ],
        {
          name: "Pranav Jha",
          email: "pranavjhacoc@gmail.com",
          phone: "919453468991",
        },
      );

      expect(profiles.github).toBeNull();
    }
  });
});

describe("calculateConfidence", () => {
  it("returns 0 for no profiles", () => {
    expect(calculateConfidence({ linkedin: null, github: null, twitter: null })).toBe(0);
  });

  it("returns 0.4 for linkedin only", () => {
    expect(
      calculateConfidence({ linkedin: "https://linkedin.com/in/x", github: null, twitter: null }),
    ).toBe(0.4);
  });

  it("returns 1.0 for all three profiles plus email match", () => {
    expect(
      calculateConfidence(
        {
          linkedin: "https://linkedin.com/in/x",
          github: "https://github.com/x",
          twitter: "https://twitter.com/x",
        },
        { emailFound: true },
      ),
    ).toBe(1.0);
  });
});

describe("findProfiles", () => {
  it("runs richer queries and computes confidence from corroborated matches", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes("site:linkedin.com/in")) {
        return [
          {
            url: "https://www.linkedin.com/in/hazibah-mustapha",
            title: "Hazibah Mustapha | LinkedIn",
            description: "myinsaka@gmail.com",
          },
        ];
      }
      if (query.includes("site:github.com") && query.includes("myinsaka@gmail.com")) {
        return [
          {
            url: "https://github.com/myinsaka",
            title: "myinsaka · GitHub",
          },
        ];
      }
      return [];
    };

    const result = await findProfiles(
      { name: "Hazibah Mustapha", email: "myinsaka@gmail.com", phone: "0177710325" },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/hazibah-mustapha");
    expect(result.profiles.github).toBe("https://github.com/myinsaka");
    expect(result.profiles.twitter).toBeNull();
    expect(result.confidence).toBe(0.8);
    expect(result.queriesRun).toHaveLength(17);
    expect(result.acceptedProfiles.length).toBeGreaterThan(0);
    expect(result.confidenceByPlatform.linkedin).toBeGreaterThan(0.5);
    expect(result.linkedinInsights).toBeNull();
  });

  it("infers company from linkedin title in 'Name - Company | LinkedIn' format", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Buoy Chankesey" site:linkedin.com/in')) {
        return [
          {
            url: "https://my.linkedin.com/in/buoy-chankesey-48117483",
            title: "Buoy Chankesey - Melon Rouge Agency | LinkedIn",
            description: "Kuala Lumpur, Malaysia",
          },
        ];
      }

      if (query.includes('"chankesey_buoy@yahoo.com" site:linkedin.com/in')) {
        return [
          {
            url: "https://my.linkedin.com/in/buoy-chankesey-48117483",
            title: "Buoy Chankesey - Melon Rouge Agency | LinkedIn",
            description: "Kuala Lumpur, Malaysia",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Buoy Chankesey",
        email: "chankesey_buoy@yahoo.com",
        phone: "+601158858515",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/buoy-chankesey-48117483");
    expect(result.company?.name).toBe("Melon Rouge Agency");
  });

  it("prefers structured linkedin company over generic about prose", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ridam Singhal" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ridamsinghal25",
            title: "Ridam Singhal - Deployed 3 Web Apps | Full Stack Developer | LinkedIn",
            description:
              "Hi, I'm Ridam Singhal, a Full Stack Developer with 1+ years of hands-on experience building web applications that solve real-world problems.",
          },
        ];
      }

      if (query.includes('"ridam.singhal@fix-it.ai"')) {
        return [
          {
            url: "https://www.linkedin.com/in/ridamsinghal25",
            title: "Ridam Singhal - Deployed 3 Web Apps | Full Stack Developer | LinkedIn",
            description:
              "Ridam Singhal\nFixit\nNoida, Uttar Pradesh, India\nAbout\n...\nExperience\nN/A",
          },
        ];
      }

      if (query.includes('"Ridam Singhal" site:x.com')) {
        return [
          {
            url: "https://x.com/ridamsinghal25",
            title: "Ridam Singhal (@ridamsinghal25) / X",
            description: "Ridam Singhal (@ridamsinghal25)",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Ridam Singhal",
        email: "ridam.singhal@fix-it.ai",
        phone: "+91847702865",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ridamsinghal25");
    expect(result.company?.name).toBe("Fixit");
    expect(result.company?.name).not.toContain("building web applications");
  });
  it("extracts linkedin company, location, and experience from accepted profile snippets", () => {
    const accepted = [
      {
        platform: "linkedin",
        url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a",
      },
    ];
    const results: SearchResult[] = [
      {
        url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a",
        title: "Choudhary Himanshu - Full Stack Developer at Fixit | LinkedIn",
        description: "Bengaluru, Karnataka, India · Experience. Fixit. 1 year",
      },
    ];

    const insights = extractLinkedinInsightsFromAccepted(accepted, results);

    expect(insights?.company).toBe("Fixit");
    expect(insights?.location).toBe("Bengaluru, Karnataka, India");
    expect(insights?.experienceYears).toBe(1);
  });

  it("extracts single-word location from linkedin snippet", () => {
    const accepted = [
      {
        platform: "linkedin",
        url: "https://www.linkedin.com/in/CHANKESEY-BUOY-48117483",
      },
    ];
    const results: SearchResult[] = [
      {
        url: "https://www.linkedin.com/in/chankesey-buoy-48117483",
        title: "Buoy Chankesey - Melon Rouge Agency | LinkedIn",
        description: "Malaysia · Experience. Melon Rouge Agency. 1 year",
      },
    ];

    const insights = extractLinkedinInsightsFromAccepted(accepted, results);

    expect(insights?.location).toBe("Malaysia");
    expect(insights?.company).toBe("Melon Rouge Agency");
  });

  it("parses months-only linkedin experience into fractional years", () => {
    const accepted = [
      {
        platform: "linkedin",
        url: "https://www.linkedin.com/in/ridamsinghal25",
      },
    ];
    const results: SearchResult[] = [
      {
        url: "https://www.linkedin.com/in/ridamsinghal25",
        title: "Ridam Singhal - Full Stack Developer | LinkedIn",
        description: "Fixit · Internship · Aug 2025 - Present · 8 mos",
      },
    ];

    const insights = extractLinkedinInsightsFromAccepted(accepted, results);
    expect(insights?.experienceYears).toBe(0.7);
  });

  it("returns related evidence links that are not direct profiles", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ritika Mishra" site:github.com')) {
        return [
          {
            url: "https://github.com/Ritika8081",
            title: "Ritika Mishra Ritika8081 - GitHub",
            description: "Reach me at ritikamis8081@gmail.com",
          },
          {
            url: "https://github.com/Ritika8081/upsidedownlabs.github.io",
            title: "Ritika8081/upsidedownlabs.github.io",
            description: "Latest commit author Ritika Mishra",
          },
        ];
      }

      if (query.includes('"Ritika Mishra" site:x.com')) {
        return [
          {
            url: "https://x.com/myupsidedownlab/status/1778400104103219448",
            title: "Welcome to the team Ritika Mishra",
            description: "Looking forward to building awesome stuff together",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      { name: "Ritika Mishra", email: "ritikamis8081@gmail.com" },
      mockSearch,
    );

    expect(result.profiles.github).toBe("https://github.com/Ritika8081");
    expect(result.evidence.some((item) => item.url.includes("upsidedownlabs.github.io"))).toBe(
      true,
    );
    expect(result.evidence.some((item) => item.url.includes("/status/1778400104103219448"))).toBe(
      true,
    );
  });

  it("discovers linkedin from selected github profile when linkedin search is inconclusive", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ritika Mishra" site:github.com')) {
        return [
          {
            url: "https://github.com/Ritika8081",
            title: "Ritika Mishra Ritika8081 - GitHub",
            description: "Reach me at ritikamis8081@gmail.com",
          },
        ];
      }

      if (query.includes('"Ritika Mishra" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritika-mishra-00",
            title: "Ritika Mishra - Deloitte - LinkedIn",
            description: "Ritika Mishra. Deloitte...",
          },
        ];
      }

      if (query.includes('"ritikamis8081@gmail.com" site:linkedin.com/in')) {
        return [];
      }

      return [];
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        '<a href="https://www.linkedin.com/in/ritika-mishra-a965251bb/">LinkedIn</a>',
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await findProfiles(
        { name: "Ritika Mishra", email: "ritikamis8081@gmail.com" },
        mockSearch,
      );

      expect(result.profiles.github).toBe("https://github.com/Ritika8081");
      expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-a965251bb");
      expect(result.evidence.some((item) => item.reason === "github-profile-linkedin-link")).toBe(
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discovers linkedin from github result snippet evidence when github profile fetch is unavailable", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ritika Mishra" site:github.com')) {
        return [
          {
            url: "https://github.com/Ritika8081",
            title: "Ritika8081 - Overview",
            description:
              'Software Developer Engineer. Links: https:\\/\\/www.linkedin.com\\/in\\/ritika-mishra-a965251bb\\/',
          },
        ];
      }
      return [];
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network blocked");
    }) as unknown as typeof fetch;

    try {
      const result = await findProfiles(
        { name: "Ritika Mishra", email: "ritikamis8081@gmail.com" },
        mockSearch,
      );

      expect(result.profiles.github).toBe("https://github.com/Ritika8081");
      expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-a965251bb");
      expect(result.evidence.some((item) => item.reason === "github-profile-linkedin-link")).toBe(
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("extracts company details from github-discovered linkedin via url lookup", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ritika Mishra" site:github.com')) {
        return [
          {
            url: "https://github.com/Ritika8081",
            title: "Ritika Mishra Ritika8081 - GitHub",
            description: "Reach me at ritikamis8081@gmail.com",
          },
        ];
      }

      if (query.includes("linkedin.com/in/ritika-mishra-a965251bb")) {
        return [
          {
            url: "https://www.linkedin.com/in/ritika-mishra-a965251bb",
            title: "Ritika Mishra - Fixit | LinkedIn",
            description: "Bengaluru, Karnataka, India · Experience. Fixit. 2 years",
          },
        ];
      }

      return [];
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        '<a href="https://www.linkedin.com/in/ritika-mishra-a965251bb/">LinkedIn</a>',
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await findProfiles(
        { name: "Ritika Mishra", email: "ritikamis8081@gmail.com", phone: "+918081742805" },
        mockSearch,
      );

      expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-a965251bb");
      expect(result.linkedinInsights?.company).toBe("Fixit");
      expect(result.company?.name).toBe("Fixit");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("extracts company details from direct linkedin profile metadata fallback", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ritika Mishra" site:github.com')) {
        return [
          {
            url: "https://github.com/Ritika8081",
            title: "Ritika Mishra Ritika8081 - GitHub",
            description: "Reach me at ritikamis8081@gmail.com",
          },
        ];
      }

      return [];
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);

      if (url.includes("github.com/Ritika8081")) {
        return new Response(
          '<a href="https://www.linkedin.com/in/ritika-mishra-a965251bb/">LinkedIn</a>',
          { status: 200 },
        );
      }

      if (url.includes("linkedin.com/in/ritika-mishra-a965251bb")) {
        return new Response(
          `
            <html>
              <head>
                <title>Ritika Mishra - Software Engineer - Upside Down Labs | LinkedIn</title>
                <meta property="og:description" content="Software Engineer at Upside Down Labs · Delhi, India" />
              </head>
              <body></body>
            </html>
          `,
          { status: 200 },
        );
      }

      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const result = await findProfiles(
        { name: "Ritika Mishra", email: "ritikamis8081@gmail.com", phone: "+918081742805" },
        mockSearch,
      );

      expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-a965251bb");
      expect(result.linkedinInsights?.company).toBe("Upside Down Labs");
      expect(result.linkedinInsights?.location).toBe("Delhi, India");
      expect(result.company?.name).toBe("Upside Down Labs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("replaces weak linkedin selection with github-derived linkedin", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ritika Mishra" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritikamishra24/",
            title: "Ritika Mishra - Goldman Sachs | LinkedIn",
            description: "Bengaluru, Karnataka, India",
          },
        ];
      }

      if (query.includes('"Ritika Mishra" site:github.com')) {
        return [
          {
            url: "https://github.com/Ritika8081",
            title: "Ritika Mishra Ritika8081 - GitHub",
            description: "Reach me at ritikamis8081@gmail.com",
          },
        ];
      }

      return [];
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("github.com/Ritika8081")) {
        return new Response(
          '<a href="https://www.linkedin.com/in/ritika-mishra-a965251bb/">LinkedIn</a>',
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const result = await findProfiles(
        { name: "Ritika Mishra", email: "ritikamis8081@gmail.com", phone: "+918081742805" },
        mockSearch,
      );

      expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-a965251bb");
      expect(result.evidence.some((item) => item.reason === "github-profile-linkedin-link")).toBe(
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers github-declared linkedin over query-level linkedin corroboration without literal identity", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ritika Mishra" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritikamishra24/",
            title: "Ritika Mishra - Goldman Sachs | LinkedIn",
            description: "Bengaluru, Karnataka, India",
          },
        ];
      }

      if (query.includes('"ritikamis8081@gmail.com" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritikamishra24/",
            title: "Ritika Mishra - Goldman Sachs | LinkedIn",
            description: "Bengaluru, Karnataka, India",
          },
        ];
      }

      if (query.includes('"Ritika Mishra" site:github.com')) {
        return [
          {
            url: "https://github.com/Ritika8081",
            title: "Ritika Mishra Ritika8081 - GitHub",
            description: "Reach me at ritikamis8081@gmail.com",
          },
        ];
      }

      return [];
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("github.com/Ritika8081")) {
        return new Response(
          '<a href="https://www.linkedin.com/in/ritika-mishra-a965251bb/">LinkedIn</a>',
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const result = await findProfiles(
        { name: "Ritika Mishra", email: "ritikamis8081@gmail.com", phone: "+918081742805" },
        mockSearch,
      );

      expect(result.profiles.github).toBe("https://github.com/Ritika8081");
      expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-a965251bb");
      expect(result.evidence.some((item) => item.reason === "github-profile-linkedin-link")).toBe(
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("downgrades weak linkedin match to candidate when no strong evidence exists", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ritika Mishra" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritikamishra24/",
            title: "Ritika Mishra - Goldman Sachs | LinkedIn",
            description: "Bengaluru, Karnataka, India",
          },
          {
            url: "https://www.linkedin.com/in/ritika-mishra-00/",
            title: "Ritika Mishra - Deloitte - LinkedIn",
            description: "Chicago, Illinois, United States",
          },
        ];
      }

      if (query.includes('"Ritika Mishra" site:github.com')) {
        return [
          {
            url: "https://github.com/Ritika8081",
            title: "Ritika Mishra Ritika8081 - GitHub",
            description: "Hi I'm Ritika Mishra",
          },
        ];
      }

      return [];
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("github.com/Ritika8081")) {
        return new Response("<html><body>No linkedin link here</body></html>", { status: 200 });
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const result = await findProfiles(
        { name: "Ritika Mishra", email: "ritikamis8081@gmail.com", phone: "+918081742805" },
        mockSearch,
      );

      expect(result.profiles.linkedin).toBeNull();
      expect(result.candidateProfiles.some((item) => item.platform === "linkedin")).toBe(true);
      expect(result.rejectionReasons.some((reason) => reason.includes("linkedin"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps linkedin accepted when same profile appears in email-targeted linkedin query", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Ridam Singhal" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ridamsinghal25",
            title: "Ridam Singhal - Deployed 3 Web Apps | Full Stack Developer | LinkedIn",
            description: "Hi, I'm Ridam Singhal, a Full Stack Developer.",
          },
          {
            url: "https://in.linkedin.com/in/ridam-singhal",
            title: "Ridam Singhal - NAV Fund Services - LinkedIn",
            description: "Jaipur, Rajasthan, India",
          },
        ];
      }

      if (query.includes('"ridam.singhal@fix-it.ai" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ridamsinghal25",
            title: "Ridam Singhal - Deployed 3 Web Apps | Full Stack Developer | LinkedIn",
            description: "Hi, I'm Ridam Singhal, a Full Stack Developer.",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      { name: "Ridam Singhal", email: "ridam.singhal@fix-it.ai", phone: "+91847702865" },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ridamsinghal25");
    expect(result.candidateProfiles.some((item) => item.platform === "linkedin")).toBe(false);
  });

  it("adds geo-enriched query for +91 numbers", async () => {
    const seenQueries: string[] = [];
    const mockSearch: WebSearchFn = async (query) => {
      seenQueries.push(query);
      return [];
    };

    await findProfiles(
      { name: "Apoorv Spandan", email: "apoorvsdn@gmail.com", phone: "+916388610470" },
      mockSearch,
    );

    expect(seenQueries.some((query) => query.includes('"Apoorv Spandan" "India"'))).toBe(true);
  });

  it("calls Hunter lookup and fills missing profiles", async () => {
    const mockSearch: WebSearchFn = async () => [];
    const enrichLookup = vi.fn(async () => ({
      linkedin: "https://www.linkedin.com/in/ridamsinghal25",
      company: { name: "Fix It", domain: "fix-it.ai", confidence: 70 },
    }));

    const result = await findProfiles(
      { name: "Ridam Singhal", email: "ridam.singhal@fix-it.ai", phone: "+91847702865" },
      mockSearch,
      { enrichLookup },
    );

    expect(enrichLookup).toHaveBeenCalledTimes(1);
    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ridamsinghal25");
    expect(result.evidence.some((item) => item.reason === "hunter-lookup")).toBe(true);
  });

  it("does not promote Enrich linkedin when it disagrees with discovered linkedin candidate", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Nazrila Liyana" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/nazrila-liyana-557465283",
            title: "Nazrila Liyana - TODAK FUSION® SDN BHD | LinkedIn",
            description: "Kuala Lumpur, Malaysia",
          },
        ];
      }
      return [];
    };

    const enrichLookup = vi.fn(async () => ({
      linkedin: "https://www.linkedin.com/in/some-other-person-999999",
    }));

    const result = await findProfiles(
      { name: "Nazrila Liyana", email: "nazrilaliyana05@gmail.com", phone: "+60135330563" },
      mockSearch,
      { enrichLookup },
    );

    expect(enrichLookup).toHaveBeenCalledTimes(1);
    expect(result.profiles.linkedin).toBeNull();
    expect(result.candidateProfiles.some((candidate) => candidate.platform === "linkedin")).toBe(
      true,
    );
  });

  it("still calls Hunter lookup when confidence is already high", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Hazibah Mustapha" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/hazibah-mustapha",
            title: "Hazibah Mustapha | LinkedIn",
            description: "myinsaka@gmail.com",
          },
        ];
      }
      if (query.includes('"myinsaka@gmail.com" site:github.com')) {
        return [
          {
            url: "https://github.com/myinsaka",
            title: "myinsaka · GitHub",
          },
        ];
      }
      return [];
    };

    const enrichLookup = vi.fn(async () => ({
      linkedin: "https://www.linkedin.com/in/should-not-be-used",
    }));

    const result = await findProfiles(
      { name: "Hazibah Mustapha", email: "myinsaka@gmail.com", phone: "0177710325" },
      mockSearch,
      { enrichLookup },
    );

    expect(result.confidence).toBe(0.8);
    expect(enrichLookup).toHaveBeenCalledTimes(1);
  });

  it("calls Hunter lookup whenever enrichment is configured", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Hazibah Mustapha" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/hazibah-mustapha",
            title: "Hazibah Mustapha | LinkedIn",
            description: "myinsaka@gmail.com",
          },
        ];
      }
      if (query.includes('"myinsaka@gmail.com" site:github.com')) {
        return [
          {
            url: "https://github.com/myinsaka",
            title: "myinsaka · GitHub",
          },
        ];
      }
      return [];
    };

    const enrichLookup = vi.fn(async () => ({
      twitter: "https://twitter.com/hazibah_dev",
    }));

    const result = await findProfiles(
      { name: "Hazibah Mustapha", email: "myinsaka@gmail.com", phone: "0177710325" },
      mockSearch,
      { enrichLookup },
    );
    expect(result.confidence).toBe(1);
    expect(enrichLookup).toHaveBeenCalledTimes(1);
    expect(result.profiles.twitter).toBe("https://twitter.com/hazibah_dev");
  });

  it("continues processing when some search queries fail", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes("site:github.com")) {
        throw new Error("GitHub search provider outage");
      }

      if (query.includes('"ritikamis8081@gmail.com" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritika-mishra-1234",
            title: "Ritika Mishra | LinkedIn",
            description: "Contact: ritikamis8081@gmail.com",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      { name: "Ritika Mishra", email: "ritikamis8081@gmail.com" },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-1234");
    expect(result.providerSignals.pdlUsed).toBe(false);
    expect(result.providerSignals.hunterUsed).toBe(false);
  });

  it("returns PDL anchor when all search queries fail", async () => {
    const mockSearch: WebSearchFn = async () => {
      throw new Error("All search providers failed");
    };
    const pdlLookup = vi.fn(async () => ({
      linkedin: "https://www.linkedin.com/in/anis-example-123",
      company: { name: "Example Labs", domain: "examplelabs.ai", confidence: 88 },
    }));

    const result = await findProfiles(
      { name: "Anis", email: "sitinuranis25@gmail.com", phone: "+60133967136" },
      mockSearch,
      { pdlLookup },
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/anis-example-123");
    expect(result.company?.name).toBe("Example Labs");
    expect(result.providerSignals.pdlUsed).toBe(true);
    expect(result.providerSignals.pdlContributed).toBe(true);
    expect(result.providerSignals.hunterUsed).toBe(false);
  });

  it("returns strong linkedin candidates even when strict accepted is null", async () => {
    const base = {
      title: "Choudhary Himanshu - Full Stack Developer | LinkedIn",
      description: "Bengaluru, Karnataka, India",
      sourceQuery: '"Choudhary Himanshu" site:linkedin.com/in',
    };

    const mockSearch: WebSearchFn = async (query) => {
      if (!query.includes("site:linkedin.com/in")) return [];
      return [
        { ...base, url: "https://www.linkedin.com/in/choudhary-himanshu-aaaa" },
        { ...base, url: "https://www.linkedin.com/in/choudhary-himanshu-aaaa" },
        { ...base, url: "https://www.linkedin.com/in/choudhary-himanshu-aaaa" },
        { ...base, url: "https://www.linkedin.com/in/choudhary-himanshu-aaaa" },
        { ...base, url: "https://www.linkedin.com/in/choudhary-himanshu-bbbb" },
        { ...base, url: "https://www.linkedin.com/in/choudhary-himanshu-bbbb" },
        { ...base, url: "https://www.linkedin.com/in/choudhary-himanshu-bbbb" },
        { ...base, url: "https://www.linkedin.com/in/choudhary-himanshu-bbbb" },
      ];
    };

    const result = await findProfiles({ name: "Choudhary Himanshu" }, mockSearch);

    expect(result.profiles.linkedin).toBeNull();
    const strongLinkedin = result.strongCandidates.filter(
      (candidate) => candidate.platform === "linkedin",
    );
    expect(strongLinkedin.length).toBeGreaterThan(0);
    expect(strongLinkedin.some((candidate) => candidate.corroborated === false)).toBe(true);
    expect(result.candidateProfiles.some((candidate) => candidate.platform === "linkedin")).toBe(
      false,
    );
    expect(
      result.rejectionReasons.some((reason) =>
        reason.includes("multiple strong but non-corroborated matches"),
      ),
    ).toBe(true);
  });

  it("caps strong candidates to top 5 per platform", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (!query.includes("site:linkedin.com/in")) return [];
      return Array.from({ length: 8 }, (_, index) => ({
        url: `https://www.linkedin.com/in/test-user-${index}`,
        title: "Test User - Full Stack Developer | LinkedIn",
        description: "Bengaluru, Karnataka, India",
        sourceQuery: '"Test User" site:linkedin.com/in',
      }));
    };

    const result = await findProfiles({ name: "Test User" }, mockSearch);
    const strongLinkedin = result.strongCandidates.filter(
      (candidate) => candidate.platform === "linkedin",
    );
    expect(strongLinkedin.length).toBeLessThanOrEqual(5);
  });

  it("extracts linkedin insights from a single strong candidate when accepted linkedin is missing", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (
        query.includes('"Buoy Chankesey"') &&
        !query.includes("chankesey_buoy@yahoo.com") &&
        !query.includes("1158858515")
      ) {
        return [
          {
            url: "https://www.linkedin.com/in/buoy-chankesey-48117483",
            title: "Buoy Chankesey - Team Lead at Melon Rouge Agency | LinkedIn",
            description: "Kuala Lumpur, Malaysia · Experience. Melon Rouge Agency. 8 years",
            sourceQuery: '"Buoy Chankesey" site:linkedin.com/in',
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Buoy Chankesey",
        email: "chankesey_buoy@yahoo.com",
        phone: "1158858515",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(result.linkedinInsights?.company).toBe("Melon Rouge Agency");
    expect(result.linkedinInsights?.location).toBe("Kuala Lumpur, Malaysia");
    expect(result.linkedinInsights?.experienceYears).toBe(8);
    expect(result.linkedinInsights?.sourceTier).toBe("candidate-linkedin");
  });

  it("surfaces company insight from 40% linkedin candidate title format", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (
        query.includes('"Nazrila Liyana"') &&
        query.includes("site:linkedin.com/in") &&
        !query.includes("nazrilaliyana05@gmail.com") &&
        !query.includes("+60135330563")
      ) {
        return [
          {
            url: "https://my.linkedin.com/in/nazrila-liyana-557465283",
            title: "Nazrila Liyana - TODAK FUSION® SDN BHD | LinkedIn",
            description: "Kuala Lumpur, Malaysia",
          },
        ];
      }
      return [];
    };

    const result = await findProfiles(
      {
        name: "Nazrila Liyana",
        email: "nazrilaliyana05@gmail.com",
        phone: "+60135330563",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(result.candidateProfiles.some((candidate) => candidate.platform === "linkedin")).toBe(
      true,
    );
    expect(result.linkedinInsights?.company).toBe("TODAK FUSION® SDN BHD");
    expect(result.linkedinInsights?.sourceTier).toBe("candidate-linkedin");
    expect(result.company?.name).toBe("TODAK FUSION® SDN BHD");
    expect(result.company?.confidence).toBe(35);
    expect(result.company?.sources[0]?.source).toBe("candidate-linkedin");
  });

  it("does not accept unrelated linkedin from email-targeted query without strong name anchor", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Choudhary Himanshu" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a/",
            title: "Choudhary Himanshu - Student at SRM University | Web Developer",
            description: "Fixit SRM University. India.",
          },
          {
            url: "https://www.linkedin.com/in/choudhary-himanshu-945313147/",
            title: "Choudhary Himanshu - Optum - LinkedIn",
            description: "Gurugram, Haryana, India",
          },
        ];
      }

      if (query.includes('"himanshuch3003@gmail.com" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/himanshufi",
            title: "Himanshu FI - Sales Associate | LinkedIn",
            description: "No surname match in this profile",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Choudhary Himanshu",
        email: "himanshuch3003@gmail.com",
        phone: "+919627314738",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(result.acceptedProfiles.some((profile) => profile.url.includes("/himanshufi"))).toBe(
      false,
    );
    expect(result.strongCandidates.some((candidate) => candidate.url.includes("/himanshufi"))).toBe(
      false,
    );
  });

  it("does not accept weak corroborated linkedin when stronger conflicting candidates exist", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Choudhary Himanshu" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/choudhary-himanshu",
            title: "Choudhary Himanshu - Profile | LinkedIn",
            description: "Gurugram, India",
          },
          {
            url: "https://www.linkedin.com/in/choudhary-himanshu-945313147",
            title: "Choudhary Himanshu - Optum - LinkedIn",
            description: "Gurugram, Haryana, India",
          },
        ];
      }

      if (query.includes('"himanshuch3003@gmail.com" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/hcgogo",
            title: "Himanshu Choudhary - Goldman Sachs | LinkedIn",
            description: "Delhi, India",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Choudhary Himanshu",
        email: "himanshuch3003@gmail.com",
        phone: "+919627314738",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(result.acceptedProfiles.some((profile) => profile.url.includes("/hcgogo"))).toBe(false);
  });

  it("does not return unrelated linkedin candidate from phone-targeted hit without name anchor", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Firdaus" site:linkedin.com/in')) {
        return [];
      }

      if (query.includes('"129318316" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/alisha-gaikwad-129318316",
            title: "Alisha Gaikwad | LinkedIn",
            description: "Profile discovered by phone search",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Firdaus",
        phone: "129318316",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(
      result.candidateProfiles.some(
        (candidate) =>
          candidate.platform === "linkedin" && candidate.url.includes("/alisha-gaikwad-129318316"),
      ),
    ).toBe(false);
  });

  it("does not accept linkedin profile solely from phone digits in URL slug", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Firdaus" site:linkedin.com/in')) {
        return [];
      }

      if (query.includes('"129318316" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/alisha-gaikwad-129318316",
            title: "Alisha Gaikwad | LinkedIn",
            description: "Kuala Lumpur, Malaysia",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Firdaus",
        email: "firdauseet23.msq@gmail.com",
        phone: "129318316",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(
      result.acceptedProfiles.some((profile) => profile.url.includes("/alisha-gaikwad-129318316")),
    ).toBe(false);
  });

  it("does not accept non-name-matching linkedin from phone suffix (Anis case)", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Anis" site:linkedin.com/in')) {
        return [];
      }

      if (query.includes('"133967136" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/andrew-prior-133967136",
            title: "Andrew Prior | LinkedIn",
            description: "TECH SERVICES LIMITED",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Anis",
        email: "sitinuranis25@gmail.com",
        phone: "133967136",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(
      result.candidateProfiles.some((candidate) =>
        candidate.url.includes("/andrew-prior-133967136"),
      ),
    ).toBe(false);
  });

  it("does not accept non-name-matching linkedin from phone suffix (AINUL case)", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"AINUL NAJWA" site:linkedin.com/in')) {
        return [];
      }

      if (query.includes('"189147259" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/raquel-junkes-189147259",
            title: "Raquel Junkes | LinkedIn",
            description: "Faculdade Censupeg",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "AINUL NAJWA",
        email: "ainulremzan@gmail.com",
        phone: "189147259",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(
      result.candidateProfiles.some((candidate) =>
        candidate.url.includes("/raquel-junkes-189147259"),
      ),
    ).toBe(false);
  });

  it("does not suggest linkedin candidate when snippet geo conflicts with phone country", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Janice" "Malaysia" site:linkedin.com/in')) {
        return [];
      }

      if (query.includes('"Janice" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/janicele",
            title: "Janice Le | LinkedIn",
            description:
              "CMO, Product Executive. Former Microsoft, Palo Alto Networks, HPE, Cisco. San Francisco Bay Area.",
          },
        ];
      }

      if (query.includes('"146209880" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/janicele",
            title: "Janice Le | LinkedIn",
            description:
              "CMO, Product Executive. Former Microsoft, Palo Alto Networks, HPE, Cisco. San Francisco Bay Area.",
          },
        ];
      }

      return [];
    };

    const result = await findProfiles(
      {
        name: "Janice",
        email: "janicetey0531@gmail.com",
        phone: "146209880",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBeNull();
    expect(result.candidateProfiles.some((candidate) => candidate.url.includes("/janicele"))).toBe(
      false,
    );
    expect(result.strongCandidates.some((candidate) => candidate.url.includes("/janicele"))).toBe(
      false,
    );
  });

  it("continues profile lookup when Enrich fallback throws", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Hazibah Mustapha" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/hazibah-mustapha",
            title: "Hazibah Mustapha | LinkedIn",
            description: "myinsaka@gmail.com",
          },
        ];
      }
      return [];
    };

    const enrichLookup = vi.fn(async () => {
      throw new Error("Enrich.so lookup error: 404 Not Found");
    });

    const result = await findProfiles(
      { name: "Hazibah Mustapha", email: "myinsaka@gmail.com" },
      mockSearch,
      { enrichLookup },
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/hazibah-mustapha");
    expect(enrichLookup).toHaveBeenCalledTimes(1);
  });

  it("uses PDL linkedin as primary anchor before search corroboration", async () => {
    const mockSearch: WebSearchFn = async () => [];
    const pdlLookup = vi.fn(async () => ({
      linkedin: "https://www.linkedin.com/in/Anis-Example-123",
      company: { name: "Example Labs", domain: "examplelabs.ai", confidence: 88 },
      linkedinInsights: { company: "Example Labs", location: "Malaysia", experienceYears: 4 },
    }));

    const result = await findProfiles(
      { name: "Anis", email: "sitinuranis25@gmail.com", phone: "+60133967136" },
      mockSearch,
      { pdlLookup },
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/anis-example-123");
    expect(result.company?.name).toBe("Example Labs");
    expect(result.providerSignals.pdlUsed).toBe(true);
    expect(result.providerSignals.pdlContributed).toBe(true);
    expect(result.resultOrigins.linkedin).toBe("pdl");
    expect(result.resultOrigins.company).toBe("pdl");
    expect(result.evidence.some((item) => item.reason === "pdl-lookup")).toBe(true);
  });

  it("falls back to search discovery when PDL has no match", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"ritikamis8081@gmail.com" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritika-mishra-1234",
            title: "Ritika Mishra | LinkedIn",
            description: "Contact: ritikamis8081@gmail.com",
          },
        ];
      }
      return [];
    };
    const pdlLookup = vi.fn(async () => null);

    const result = await findProfiles(
      { name: "Ritika Mishra", email: "ritikamis8081@gmail.com" },
      mockSearch,
      { pdlLookup },
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-1234");
    expect(result.providerSignals.pdlUsed).toBe(true);
    expect(result.providerSignals.pdlContributed).toBe(false);
    expect(result.resultOrigins.linkedin).toBe("search");
  });

  it("does not let conflicting PDL linkedin overwrite strongly corroborated search linkedin", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"ritikamis8081@gmail.com" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritika-mishra-1234",
            title: "Ritika Mishra | LinkedIn",
            description: "Contact: ritikamis8081@gmail.com",
          },
        ];
      }
      return [];
    };

    const pdlLookup = vi.fn(async () => ({
      linkedin: "https://www.linkedin.com/in/some-other-person-9999",
    }));

    const result = await findProfiles(
      { name: "Ritika Mishra", email: "ritikamis8081@gmail.com" },
      mockSearch,
      { pdlLookup },
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-1234");
    expect(result.providerSignals.pdlContributed).toBe(false);
    expect(result.evidence.some((item) => item.reason === "pdl-lookup")).toBe(false);
  });

  it("continues with search-based results when PDL lookup throws", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"ritikamis8081@gmail.com" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/ritika-mishra-1234",
            title: "Ritika Mishra | LinkedIn",
            description: "Contact: ritikamis8081@gmail.com",
          },
        ];
      }
      return [];
    };
    const pdlLookup = vi.fn(async () => {
      throw new Error("PDL timeout");
    });

    const result = await findProfiles(
      { name: "Ritika Mishra", email: "ritikamis8081@gmail.com" },
      mockSearch,
      { pdlLookup },
    );

    expect(result.profiles.linkedin).toBe("https://www.linkedin.com/in/ritika-mishra-1234");
    expect(result.providerSignals.pdlUsed).toBe(true);
    expect(result.providerSignals.pdlContributed).toBe(false);
  });
});

describe("Hunter integration", () => {
  it("returns null on 404 from Hunter", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    ) as unknown as typeof fetch;

    try {
      const lookup = createEnrichLookupFn({ hunterApiKey: "test-key" });
      const result = await lookup({ name: "Ridam Singhal", email: "ridam.singhal@fix-it.ai" });
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("calls Hunter with email query params", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const lookup = createEnrichLookupFn({ hunterApiKey: "test-key" });
      await lookup({ name: "Ridam Singhal", email: "ridam.singhal@fix-it.ai" });
      expect(fetchSpy).toHaveBeenCalledOnce();
      const requestedUrl = String(fetchSpy.mock.calls[0][0]);
      expect(requestedUrl).toContain("email=ridam.singhal%40fix-it.ai");
      expect(requestedUrl).toContain("api_key=test-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips Hunter lookup when email is missing", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const lookup = createEnrichLookupFn({ hunterApiKey: "test-key" });
      const result = await lookup({ name: "No Contact" });
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips Hunter lookup when email is webmail", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const lookup = createEnrichLookupFn({ hunterApiKey: "test-key" });
      const result = await lookup({ name: "Webmail User", email: "user@gmail.com" });
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps Hunter location and experience into linkedin insights", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            person: {
              linkedin_url: "https://www.linkedin.com/in/sample-person-123",
              employment: { company_name: "Fixit" },
              city: "Bengaluru",
              state: "Karnataka",
              country: "India",
              years_experience: 6,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    try {
      const lookup = createEnrichLookupFn({ hunterApiKey: "test-key" });
      const result = await lookup({ name: "Sample Person", email: "sample@fix-it.ai" });
      expect(result?.linkedin).toBe("https://www.linkedin.com/in/sample-person-123");
      expect(result?.linkedinInsights?.company).toBe("Fixit");
      expect(result?.linkedinInsights?.location).toBe("Bengaluru, Karnataka, India");
      expect(result?.linkedinInsights?.experienceYears).toBe(6);

      const stitched = await findProfiles(
        { name: "No Match", email: "sample@fix-it.ai" },
        async () => [],
        { enrichLookup: async () => result ?? null },
      );
      expect(stitched.linkedinInsights?.sourceTier).toBe("enrich");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drops Hunter response when both name and country checks fail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            person: {
              name: "John Doe",
              country: "United States",
              linkedin_url: "https://www.linkedin.com/in/john-doe-123",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    try {
      const lookup = createEnrichLookupFn({ hunterApiKey: "test-key" });
      const result = await lookup({
        name: "Nazrila Liyana",
        email: "nazrilaliyana05@gmail.com",
        phone: "+60135330563",
      });
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("PDL integration", () => {
  it("uses header auth and retries on 429", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limit", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            person: {
              linkedin_url: "https://www.linkedin.com/in/anis-ok-1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const lookup = createPdlLookupFn({ pdlApiKey: "pdl-key" });
      const result = await lookup({
        name: "Anis",
        email: "sitinuranis25@gmail.com",
        phone: "+60133967136",
      });

      expect(result?.linkedin).toBe("https://www.linkedin.com/in/anis-ok-1");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const firstCallUrl = String(fetchSpy.mock.calls[0][0]);
      expect(firstCallUrl).not.toContain("api_key=");
      const firstCallInit = fetchSpy.mock.calls[0][1] as RequestInit;
      const headers = firstCallInit.headers as Record<string, string>;
      expect(headers["X-Api-Key"]).toBe("pdl-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drops PDL response when both name and country checks fail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            person: {
              name: "John Doe",
              country: "United States",
              linkedin_url: "https://www.linkedin.com/in/john-doe-123",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    try {
      const lookup = createPdlLookupFn({ pdlApiKey: "pdl-key" });
      const result = await lookup({
        name: "Nazrila Liyana",
        email: "nazrilaliyana05@gmail.com",
        phone: "+60135330563",
      });
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("company inference", () => {
  it("getDomain returns null for free email providers", () => {
    expect(getDomain("user@gmail.com")).toBeNull();
    expect(getDomain("user@yahoo.in")).toBeNull();
    expect(getDomain("user@rediffmail.com")).toBeNull();
    expect(getDomain("user@hotmail.com")).toBeNull();
  });

  it("getDomain returns domain for business email", () => {
    expect(getDomain("info@shreeradhaexports.com")).toBe("shreeradhaexports.com");
    expect(getDomain("ritika@upsidedownlabs.tech")).toBe("upsidedownlabs.tech");
  });

  it("buildBusinessDirectoryQueries adds India-specific queries", () => {
    const queries = buildBusinessDirectoryQueries({
      name: "Ritika Mishra",
      phone: "+918081742805",
      email: "ritika@upsidedownlabs.tech",
      city: "Bengaluru",
      countryIso: "IN",
    });
    expect(queries.some((q) => q.q.includes("site:indiamart.com") && q.q.includes("phone"))).toBe(
      false,
    );
    expect(queries.some((q) => q.tag === "dir-phone-indiamart")).toBe(true);
    expect(queries.some((q) => q.tag === "dir-phone-justdial")).toBe(true);
    expect(queries.some((q) => q.tag === "dir-name-city-indiamart")).toBe(true);
    expect(queries.some((q) => q.tag === "dir-email-tradeindia")).toBe(true);
  });

  it("buildBusinessDirectoryQueries skips tradeindia for free email", () => {
    const queries = buildBusinessDirectoryQueries({
      name: "Ritika Mishra",
      phone: "+918081742805",
      email: "ritika@gmail.com",
      countryIso: "IN",
    });
    expect(queries.some((q) => q.tag === "dir-email-tradeindia")).toBe(false);
  });

  it("buildBusinessDirectoryQueries returns empty for non-India country", () => {
    const queries = buildBusinessDirectoryQueries({
      name: "John Smith",
      phone: "+14155001234",
      countryIso: "US",
    });
    expect(queries).toHaveLength(0);
  });

  it("buildBusinessDirectoryQueries generates Malaysia directory queries", () => {
    const queries = buildBusinessDirectoryQueries({
      name: "Ritika Mishra",
      phone: "+60123456789",
      email: "ritika@fixit.my",
      city: "Kuala Lumpur",
      countryIso: "MY",
    });

    expect(queries.some((q) => q.tag === "dir-name-city-yellowbees")).toBe(true);
    expect(queries.some((q) => q.tag === "dir-name-city-bizworldmy")).toBe(true);
    expect(queries.some((q) => q.tag === "dir-name-city-localbizmy")).toBe(true);
    expect(queries.some((q) => q.tag === "dir-email-yellowbees")).toBe(true);
    expect(queries.some((q) => q.tag === "dir-email-bizworldmy")).toBe(true);
    expect(queries.some((q) => q.tag.includes("dir-phone-"))).toBe(false);
  });

  it("extractCompanyFromSearchResults parses IndiaMART result matched by phone", () => {
    const results: SearchResult[] = [
      {
        url: "https://www.indiamart.com/shreeradha-exports/",
        title: "Shree Radha Exports - Bengaluru | IndiaMART",
        description: "Ritika Mishra, Proprietor. 8081742805. Bengaluru Karnataka.",
      },
    ];
    const evidence = extractCompanyFromSearchResults(results, {
      name: "Ritika Mishra",
      phone: "+918081742805",
    });
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].name).toBe("Shree Radha Exports");
    expect(evidence[0].type).toBe("business-directory");
    expect(evidence[0].source).toBe("indiamart");
    expect(evidence[0].matchedSignals.phone).toBe(true);
  });

  it("extractCompanyFromSearchResults skips results with no matching signals", () => {
    const results: SearchResult[] = [
      {
        url: "https://www.indiamart.com/some-other-company/",
        title: "Some Other Company | IndiaMART",
        description: "A completely unrelated listing.",
      },
    ];
    const evidence = extractCompanyFromSearchResults(results, {
      name: "Ritika Mishra",
      phone: "+918081742805",
    });
    expect(evidence).toHaveLength(0);
  });

  it("extractCompanyFromSearchResults rejects scattered-token false positives", () => {
    // "Ritika" appears in "Ritika Amit Kumar" and "Mishra" in "Varun Mishra" —
    // these are two different people, not "Ritika Mishra".
    const results: SearchResult[] = [
      {
        url: "https://www.indiamart.com/creative-ink/aboutus.html",
        title:
          "Curious Kids Media Tech Private Limited - Service Provider from Bengaluru | IndiaMART",
        description:
          "Company CEO: Ritika Amit Kumar. GST Partner Name: Ritika Amit Kumar, Varun Mishra.",
      },
    ];
    const evidence = extractCompanyFromSearchResults(results, {
      name: "Ritika Mishra",
      phone: "+918081742805",
    });
    expect(evidence).toHaveLength(0);
  });

  it("extractCompanyFromSearchResults skips testimonial/buyer pages", () => {
    const results: SearchResult[] = [
      {
        url: "https://www.indiamart.com/myka-enterprises/testimonial.html",
        title: "Myka Enterprises | IndiaMART",
        description: "Ritika Mishra | Farrukhabad, Uttar Pradesh. Rated Saffola Oil.",
      },
    ];
    const evidence = extractCompanyFromSearchResults(results, {
      name: "Ritika Mishra",
      phone: "+918081742805",
    });
    // Ritika Mishra appears here as a customer reviewer, not a business owner.
    expect(evidence).toHaveLength(0);
  });

  it("normalizeCompanyName strips legal suffixes", () => {
    expect(normalizeCompanyName("Shree Radha Exports Pvt Ltd")).toBe("shree radha exports");
    expect(normalizeCompanyName("ABC Corp Limited")).toBe("abc");
  });

  it("scoreCompanyEvidence scores directory evidence correctly", () => {
    const ev: CompanyEvidence = {
      type: "business-directory",
      name: "Shree Radha Exports",
      domain: null,
      url: "https://www.indiamart.com/shreeradha-exports/",
      source: "indiamart",
      matchedSignals: { phone: true, name: true },
    };
    const company = scoreCompanyEvidence([ev]);
    expect(company).not.toBeNull();
    expect(company?.name).toBe("Shree Radha Exports");
    // 35 (business-directory) + 20 (phone) + 10 (name) = 65
    expect(company?.confidence).toBe(65);
  });

  it("scoreCompanyEvidence gives multi-source bonus and caps at 100", () => {
    const web: CompanyEvidence = {
      type: "company-website",
      name: "Shree Radha Exports",
      domain: "shreeradhaexports.com",
      url: "https://shreeradhaexports.com",
      matchedSignals: { emailDomain: true },
    };
    const dir: CompanyEvidence = {
      type: "business-directory",
      name: "Shree Radha Exports",
      domain: null,
      url: "https://www.indiamart.com/shreeradha-exports/",
      source: "indiamart",
      matchedSignals: { phone: true, name: true },
    };
    const company = scoreCompanyEvidence([web, dir]);
    // Both have same normalizeCompanyName key → grouped together
    // 40+30 + 35+20+10 + 15 multi-source = 150 → capped at 100
    expect(company?.confidence).toBe(100);
    expect(company?.domain).toBe("shreeradhaexports.com");
  });

  it("inferCompanyFromLead returns company from directory results (gmail skips domain fetch)", async () => {
    const results: SearchResult[] = [
      {
        url: "https://www.indiamart.com/ritika-exports/",
        title: "Ritika Exports - Ritika Mishra | IndiaMART",
        description: "Contact Ritika Mishra. Phone: 8081742805. Bengaluru.",
      },
    ];
    const company = await inferCompanyFromLead(
      { name: "Ritika Mishra", email: "ritikamis8081@gmail.com", phone: "+918081742805" },
      results,
      [],
    );
    expect(company).not.toBeNull();
    expect(company?.name).toBe("Ritika Exports");
    expect(company?.confidence).toBeGreaterThan(0);
  });

  it("inferCompanyFromLead returns null when no evidence found", async () => {
    const company = await inferCompanyFromLead(
      { name: "Jane Doe", email: "jane@gmail.com", phone: "+14155001234" },
      [],
      [],
    );
    expect(company).toBeNull();
  });

  it("inferCompanyFromLead falls back to business email domain with low confidence", async () => {
    const company = await inferCompanyFromLead(
      { name: "Ridam Singhal", email: "ridam.singhal@fix-it.ai", phone: "+91847702865" },
      [],
      [],
    );
    expect(company).not.toBeNull();
    expect(company?.name).toBe("Fix It");
    expect(company?.domain).toBe("fix-it.ai");
    expect(company?.confidence).toBe(35);
    expect(company?.sources[0]?.type).toBe("email-domain-fallback");
  });

  it("inferCompanyFromLead prefers linkedin experience company over education title", async () => {
    const company = await inferCompanyFromLead(
      { name: "Choudhary Himanshu", email: "ritikamis8081@gmail.com", phone: "+919627314738" },
      [
        {
          url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a/",
          title: "Choudhary Himanshu - Student at SRM University | Web Developer",
          description:
            "I am currently a student. Experience. Fixit. 1 year 4 months. Education. SRM University.",
        },
      ],
      [{ platform: "linkedin", url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a" }],
    );

    expect(company).not.toBeNull();
    expect(company?.name).toBe("Fixit");
    expect(company?.sources.some((source) => source.type === "linkedin-profile")).toBe(true);
  });

  it("inferCompanyFromLead ignores education-only linkedin title as company", async () => {
    const company = await inferCompanyFromLead(
      { name: "Choudhary Himanshu", email: "ritikamis8081@gmail.com", phone: "+919627314738" },
      [
        {
          url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a/",
          title: "Choudhary Himanshu - Student at SRM University | Web Developer",
          description: "I am currently a student learning web development.",
        },
      ],
      [{ platform: "linkedin", url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a" }],
    );

    expect(company).toBeNull();
  });

  it("findProfiles result includes company field", async () => {
    const mockSearch: WebSearchFn = async () => [];
    const result = await findProfiles({ name: "Jane Doe", email: "jane@gmail.com" }, mockSearch);
    expect("company" in result).toBe(true);
  });

  it("findProfiles includes IndiaMART directory queries for +91 phone", async () => {
    const seenQueries: string[] = [];
    const mockSearch: WebSearchFn = async (query) => {
      seenQueries.push(query);
      return [];
    };
    await findProfiles(
      { name: "Ritika Mishra", email: "ritikamis8081@gmail.com", phone: "+918081742805" },
      mockSearch,
    );
    expect(seenQueries.some((q) => q.includes("site:indiamart.com"))).toBe(true);
    expect(seenQueries.some((q) => q.includes("site:justdial.com"))).toBe(true);
  });

  it("findProfiles includes MY directory queries for +60 phone", async () => {
    const seenQueries: string[] = [];
    const mockSearch: WebSearchFn = async (query) => {
      seenQueries.push(query);
      return [];
    };

    await findProfiles(
      { name: "Aisyah Rahman", email: "aisyah@fixit.my", phone: "+60123456789" },
      mockSearch,
    );

    expect(seenQueries.some((q) => q.includes("site:yellowbees.com.my"))).toBe(true);
    expect(seenQueries.some((q) => q.includes("site:dir.businessworld.com.my"))).toBe(true);
    expect(seenQueries.some((q) => q.includes("site:localbiznetwork.com"))).toBe(true);
  });

  it("findProfiles keeps linkedin when corroborated by name+company signal", async () => {
    const mockSearch: WebSearchFn = async (query) => {
      if (query.includes('"Choudhary Himanshu" site:linkedin.com/in')) {
        return [
          {
            url: "https://www.linkedin.com/in/choudhary-himanshu-60615625a/",
            title: "Choudhary Himanshu - Full Stack Developer at Fixit | LinkedIn",
            description: "Bengaluru, Karnataka, India",
          },
        ];
      }
      return [];
    };

    const result = await findProfiles(
      {
        name: "Choudhary Himanshu",
        email: "choudhary.himanshu@fix-it.ai",
        phone: "+919627314738",
      },
      mockSearch,
    );

    expect(result.profiles.linkedin).toBe(
      "https://www.linkedin.com/in/choudhary-himanshu-60615625a",
    );
    expect(result.candidateProfiles.some((item) => item.platform === "linkedin")).toBe(false);
  });

  it("findProfiles debug summary reports detected country and active directories", async () => {
    const mockSearch: WebSearchFn = async () => [];
    const result = await findProfiles(
      { name: "Aisyah Rahman", email: "aisyah@fixit.my", phone: "+60123456789" },
      mockSearch,
      { debug: true },
    );

    expect(result.debugSummary?.detectedCountryIso).toBe("MY");
    expect(result.debugSummary?.activatedDirectorySources).toContain("yellowbees");
    expect(result.debugSummary?.activatedDirectorySources).toContain("bizworldmy");
    expect(result.debugSummary?.activatedDirectorySources).toContain("localbizmy");
  });
});
