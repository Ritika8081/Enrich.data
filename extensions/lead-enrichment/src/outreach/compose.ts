import type { ProfileFinderResult } from "../profile_finder/find_profiles.js";

export type OutreachLead = {
  name: string;
  email?: string;
  phone?: string;
};

export type OutreachDraft = {
  subject: string;
  email: string;
  linkedinDm: string;
};

export type ComposeOutreachOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  brief?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ComposeContext = {
  lead: OutreachLead;
  enrichment: Pick<
    ProfileFinderResult,
    "profiles" | "company" | "linkedinInsights" | "confidence"
  >;
};

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BRIEF =
  "Reach out to introduce yourself, reference one specific detail from their background, and ask for a 15-minute intro call. Tone: warm, concise, no jargon, no hard sell.";

const SYSTEM_PROMPT = `You write short, personalized outreach drafts for sales/recruiting. You receive a JSON object with the lead's enriched profile (name, role, company, location, github/linkedin/twitter handles, confidence) and a campaign brief. You produce ONE cold email and ONE LinkedIn DM.

Rules:
- Reference exactly ONE concrete detail from the enrichment (their company, role, location, or github activity). Never invent details that are not in the input.
- Email: 70-110 words. Plain text, no markdown. Single clear ask. No "I hope this finds you well".
- LinkedIn DM: under 300 characters. Conversational, no formal greeting.
- Subject: 4-7 words, lowercase first letter, no clickbait, no emojis.
- If the enrichment has very little signal (no company, no role, low confidence), keep the message generic-but-warm — do NOT fabricate context.
- Output ONLY a JSON object with keys "subject", "email", "linkedinDm". No prose, no code fences.`;

function buildUserPrompt(context: ComposeContext, brief: string): string {
  const enrichment = {
    name: context.lead.name,
    email: context.lead.email,
    linkedin: context.enrichment.profiles.linkedin ?? null,
    github: context.enrichment.profiles.github ?? null,
    twitter: context.enrichment.profiles.twitter ?? null,
    company: context.enrichment.company?.name ?? null,
    role: context.enrichment.linkedinInsights?.company ?? null,
    location: context.enrichment.linkedinInsights?.location ?? null,
    experienceYears: context.enrichment.linkedinInsights?.experienceYears ?? null,
    confidence: Math.round(context.enrichment.confidence * 100),
  };

  return [
    `Campaign brief: ${brief}`,
    "",
    "Enriched lead:",
    JSON.stringify(enrichment, null, 2),
    "",
    'Return JSON: {"subject": "...", "email": "...", "linkedinDm": "..."}',
  ].join("\n");
}

function tryParseDraft(raw: string): OutreachDraft | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Find the first balanced JSON object — guards against preamble or trailing prose.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  const slice = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as Record<string, unknown>;
    const subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
    const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
    const linkedinDm = typeof parsed.linkedinDm === "string" ? parsed.linkedinDm.trim() : "";
    if (!subject || !email || !linkedinDm) return null;
    return { subject, email, linkedinDm };
  } catch {
    return null;
  }
}

export async function composeOutreach(
  context: ComposeContext,
  options: ComposeOutreachOptions,
): Promise<OutreachDraft> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const brief = (options.brief ?? "").trim() || DEFAULT_BRIEF;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalAbort = options.signal;
  const onExternalAbort = () => controller.abort();
  externalAbort?.addEventListener("abort", onExternalAbort);

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(context, brief) },
        ],
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `outreach LLM request failed: ${response.status} ${response.statusText}${
          bodyText ? ` | ${bodyText.slice(0, 200)}` : ""
        }`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content ?? "";
    const draft = tryParseDraft(text);
    if (!draft) {
      throw new Error("outreach LLM returned unparseable output");
    }
    return draft;
  } finally {
    clearTimeout(timer);
    externalAbort?.removeEventListener("abort", onExternalAbort);
  }
}

export type ComposeOutreachFn = (
  context: ComposeContext,
  options?: Partial<ComposeOutreachOptions>,
) => Promise<OutreachDraft>;

export function createOutreachComposer(
  defaults: ComposeOutreachOptions,
): ComposeOutreachFn {
  return (context, overrides) =>
    composeOutreach(context, { ...defaults, ...(overrides ?? {}) });
}

export const __testables = {
  buildUserPrompt,
  tryParseDraft,
  SYSTEM_PROMPT,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
};
