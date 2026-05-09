# Lead Enrichment

> Turn a name (and maybe an email or phone) into verified LinkedIn, GitHub, and Twitter profiles - with confidence scores - plus a personalized cold email and LinkedIn DM, in seconds.

**👉 [See the live demo (no install)](./extensions/lead-enrichment/docs/demo.html)** - open `extensions/lead-enrichment/docs/demo.html` in your browser. Profile cards, AI-drafted outreach, real bulk output. No API keys needed.

---

## Why this project stands out

| | |
|---|---|
| ⚡ **~100x faster than manual research** | What takes an SDR / recruiter 5-10 minutes per lead runs in seconds, end-to-end. |
| 💸 **$0 on the default stack** | Every provider has a free tier, none require a credit card. Most enrichment tools start at $99/mo. |
| 🛡️ **Four-provider fallback, no single point of failure** | Serper + Tavily run in parallel and dedup. If they miss, PDL takes over with retry + exponential backoff. Hunter is the final net for email-only inputs. |
| 🎯 **Per-platform confidence scores** | LinkedIn 0.9, GitHub 0.86, Twitter 0.82 — not one fuzzy blended number. Downstream code can threshold per-channel. |
| 🔌 **Provider-agnostic LLM** | Works with Groq, OpenAI, Together, or local Ollama by changing one env var. Outreach is fail-open — enrichment still completes if the LLM is down. |
| 📦 **Zero-dependency HTML preview** | Bulk runs ship a self-contained HTML alongside the CSV — no framework, no server, drag-drop friendly. |
| 🧪 **Production-grade resilience** | Honors `Retry-After` on 429, rejects webmail before billing Hunter, per-row error rows so one bad input never kills a batch of thousands. |
| ✅ **Tested where it matters** | Vitest coverage on dedup logic, CSV parser/formatter, and the fallback chain — the parts that break silently. |

### Strong points at a glance

- **Resilience-first design** - dual search, retries with `Retry-After` honoring, fail-open AI, per-row error isolation.
- **Cost-aware engineering** - webmail filter saves Hunter credits; provider chain stops at first hit; LLM swap requires no code change.
- **Clean architecture** - TypeScript ESM, strict typing, plugin-shaped, dependency-injected, Vitest-tested.
- **Real product polish** - confidence scores per platform, country inference from phone, drag-drop HTML preview.
- **Drop-in for any pipeline** - CLI for humans, structured CSV+HTML output for downstream tools, OpenAI-compatible LLM interface for any host.

## What it does

Give it `{ name, email?, phone? }` and it returns:

- LinkedIn, GitHub, Twitter profile URLs
- Inferred company + role (from LinkedIn page extraction)
- Per-platform confidence score (LinkedIn 0.9, GitHub 0.86, Twitter 0.82 when matched directly)
- Country inference from phone number for region-aware filtering
- AI-drafted cold email + LinkedIn DM, personalized using the enriched data (role, company, location, GitHub activity)
- A self-contained HTML preview alongside the enriched CSV - drag-drop friendly, no framework, no server

Two modes:
- Single lookup - `/leadfind --name "Jane Doe" --email jane@acme.com --brief "Reach out for a 15-min call"`
- Bulk CSV - drop in a CSV, get back an enriched CSV + an HTML preview page, with per-row error tracking

## Why it exists

Manual SDR / recruiter research takes ~5-10 minutes per lead and breaks at scale. Most paid enrichment APIs return one source and stop. This plugin chains four providers with graceful fallback so you actually get an answer, not a 404.

## How it works

```text
name + email/phone
   |
   v
┌─────────────────────────┐    ┌──────────────────────┐
│ Serper search  ──┐      │    │  PDL enrichment      │
│                  ├─dedup├───▶│  (retry + backoff)   │
│ Tavily search  ──┘      │    └──────────┬───────────┘
└─────────────────────────┘               │ miss
            │                             ▼
            ▼                  ┌──────────────────────┐
   LinkedIn page scrape        │ Hunter (email only,  │
   + GitHub README crawl       │ rejects webmail)     │
            │                  └──────────┬───────────┘
            ▼                             │
       confidence-scored profiles ◀───────┘
```

## Engineering decisions

- **Dual search (Serper + Tavily)** - deduplicates results, continues if one provider 5xx's. No single point of failure.
- **Retry + exponential backoff** - PDL: 2 retries, 300ms base, 12s timeout, honors `Retry-After` on 429.
- **Webmail rejection** - Hunter never gets called for `@gmail.com` etc., saving credits and avoiding garbage matches.
- **Confidence per platform, not a single blended score** - lets downstream code threshold per-channel (`linkedin >= 0.85`, `twitter >= 0.7`).
- **In-memory bulk CSV with per-row error rows** - a single bad input never kills a batch.
- **Provider-agnostic LLM** - outreach uses any OpenAI-compatible endpoint. Default is Groq's free tier (no credit card, generous limits). Swap to OpenAI / Together / Ollama by changing one env var.
- **Fail-open AI step** - if the LLM is down or the key is missing, enrichment still completes. Outreach drafts are an enhancement, not a dependency.

## Tech stack

- **Language** - TypeScript (ESM, strict typing), Node 22+
- **Runtime** - works in the OpenClaw plugin host; CLI exposed as `/leadfind`
- **Search** - Serper, Tavily (parallel + dedup)
- **Enrichment** - People Data Labs, Hunter (with webmail filter)
- **LLM** - any OpenAI-compatible endpoint (Groq Llama 3.3 70B by default)
- **Tests** - Vitest
- **Validation** - `@sinclair/typebox` for typed schemas

## Quick start

```bash
# 1. Search providers - required, both free tiers, no card.
export SERPER_API_KEY=...     # 2,500 free queries: https://serper.dev
export TAVILY_API_KEY=...     # 1,000 free queries/mo: https://tavily.com

# 2. Optional fallback enrichers (free tiers available)
export PDL_API_KEY=...        # https://www.peopledatalabs.com
export HUNTER_API_KEY=...     # 25 free/mo: https://hunter.io

# 3. AI outreach - free with Groq, no card required
export GROQ_API_KEY=...       # https://console.groq.com  (Llama 3.3 70B free tier)

# 4. Single lookup with personalized outreach
/leadfind --name "Jane Doe" --email jane@acme.com \
  --brief "I'm a senior eng looking for a VP Eng role at growth-stage SaaS"

# 5. Bulk - outputs enriched.csv + enriched.html (open in browser)
/leadfind ./leads.csv
```

### Cost: $0 on the default free-tier setup

| Provider | Free tier | Card required? |
|---|---|---|
| Serper | 2,500 queries | No |
| Tavily | 1,000 queries/mo | No |
| Hunter | 25 lookups/mo | No |
| PDL | Free trial credits | No |
| Groq (LLM) | Generous free tier on Llama 3.3 70B | No |

### Swap the AI provider (still OpenAI-compatible REST)

```bash
# OpenAI
export OUTREACH_BASE_URL=https://api.openai.com/v1
export OUTREACH_MODEL=gpt-4o-mini
export OUTREACH_API_KEY=sk-...

# Together AI
export OUTREACH_BASE_URL=https://api.together.xyz/v1
export OUTREACH_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
export OUTREACH_API_KEY=...

# Local Ollama (truly $0, runs offline)
export OUTREACH_BASE_URL=http://localhost:11434/v1
export OUTREACH_MODEL=llama3.1
export OUTREACH_API_KEY=ollama
```

## Tests

```bash
pnpm test extensions/lead-enrichment
```

Covers the dedup logic, the bulk CSV parser/formatter, and the fallback chain.

## Roadmap

- Caching layer (Redis) - same lead queried twice = 0 API calls
- Per-provider cost meter so you can see $/lead live
- Salary estimation pass (already scaffolded in `package.json` description)
- Webhook output for Zapier / n8n flows
- One-click Vercel deploy of the HTML preview as a hosted dashboard (drag-drop CSV -> live progress)
- MCP server wrapper so Claude Code / Cursor users can invoke `/leadfind` from inside their IDE
