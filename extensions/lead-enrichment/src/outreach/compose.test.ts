import { describe, it, expect, vi } from "vitest";
import { composeOutreach, __testables } from "./compose.js";
import type { ProfileFinderResult } from "../profile_finder/find_profiles.js";

const baseEnrichment: ComposeContextEnrichment = {
  profiles: {
    linkedin: "https://www.linkedin.com/in/jane-doe",
    github: "https://github.com/janedoe",
    twitter: null,
  },
  company: { name: "Acme Inc", confidence: 92, domain: "acme.com", sources: [] },
  linkedinInsights: {
    company: "VP Engineering at Acme Inc",
    location: "Berlin, Germany",
    experienceYears: 12,
    sourceTier: "scrape",
  },
  confidence: 0.88,
};

type ComposeContextEnrichment = Pick<
  ProfileFinderResult,
  "profiles" | "company" | "linkedinInsights" | "confidence"
>;

function mockJsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("composeOutreach", () => {
  it("returns parsed draft on a well-formed LLM response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockJsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: "quick question about acme's eng growth",
                email: "Hi Jane,\n\nSaw you lead engineering at Acme — congrats on the recent hires.\n\nI work with VP Engs scaling 50→200 person teams. Would you be open to a 15-minute swap of notes next week?\n\nThanks,\nRitik",
                linkedinDm: "Hi Jane — saw your work scaling Acme's eng org. I help VPs in similar shapes; open to a 15-min chat?",
              }),
            },
          },
        ],
      }),
    );

    const draft = await composeOutreach(
      { lead: { name: "Jane Doe", email: "jane@acme.com" }, enrichment: baseEnrichment },
      { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(draft.subject).toMatch(/acme/i);
    expect(draft.email.length).toBeGreaterThan(40);
    expect(draft.linkedinDm.length).toBeLessThan(320);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(__testables.DEFAULT_MODEL);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("strips ```json fences and tolerates surrounding prose", async () => {
    const messy = [
      "Sure, here is the draft:",
      "```json",
      JSON.stringify({
        subject: "intro on berlin scaling",
        email: "Hi Jane, ...",
        linkedinDm: "Hi Jane — quick note from Berlin tech.",
      }),
      "```",
      "Hope this helps!",
    ].join("\n");

    const fetchImpl = vi.fn().mockResolvedValue(
      mockJsonResponse({ choices: [{ message: { content: messy } }] }),
    );

    const draft = await composeOutreach(
      { lead: { name: "Jane Doe" }, enrichment: baseEnrichment },
      { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(draft.subject).toBe("intro on berlin scaling");
  });

  it("throws on non-2xx HTTP responses with a descriptive message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("rate limit hit", { status: 429, statusText: "Too Many Requests" }),
    );

    await expect(
      composeOutreach(
        { lead: { name: "Jane" }, enrichment: baseEnrichment },
        { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/429|Too Many Requests|rate limit/i);
  });

  it("throws when the LLM returns unparseable output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockJsonResponse({
        choices: [{ message: { content: "I cannot do that." } }],
      }),
    );

    await expect(
      composeOutreach(
        { lead: { name: "Jane" }, enrichment: baseEnrichment },
        { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/unparseable/i);
  });

  it("respects baseUrl override and trims trailing slashes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockJsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: "ok",
                email: "hi there",
                linkedinDm: "hi there",
              }),
            },
          },
        ],
      }),
    );

    await composeOutreach(
      { lead: { name: "Jane" }, enrichment: baseEnrichment },
      {
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1/",
        model: "gpt-4o-mini",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("falls back to the default brief when none is provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockJsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                subject: "ok",
                email: "hi",
                linkedinDm: "hi",
              }),
            },
          },
        ],
      }),
    );

    await composeOutreach(
      { lead: { name: "Jane" }, enrichment: baseEnrichment },
      { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const userMessage = body.messages[1].content as string;
    expect(userMessage).toMatch(/Campaign brief: /);
    expect(userMessage).toMatch(/Reach out to introduce yourself/);
  });
});

describe("tryParseDraft", () => {
  const { tryParseDraft } = __testables;

  it("returns null when any required field is empty", () => {
    expect(
      tryParseDraft(JSON.stringify({ subject: "", email: "x", linkedinDm: "y" })),
    ).toBeNull();
    expect(
      tryParseDraft(JSON.stringify({ subject: "x", email: "  ", linkedinDm: "y" })),
    ).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(tryParseDraft("not json at all")).toBeNull();
  });
});
