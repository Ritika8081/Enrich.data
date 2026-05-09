import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHtmlPreview } from "../src/outreach/html_preview.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(__dirname, "..", "docs", "demo.html");

// IMPORTANT: every value in this file is synthetic/placeholder.
// Names like "Sample Lead", emails on example.com, and company names like
// "Example Corp" are intentionally obvious placeholders. Do NOT replace them
// with real people or real companies — this file is committed publicly.
const demoRows = [
  {
    name: "Sample Lead 1",
    email: "lead-1@example.com",
    phone: undefined,
    linkedin: "https://www.linkedin.com/in/sample-lead-1",
    github: "https://github.com/sample-lead-1",
    twitter: "https://x.com/sample_lead_1",
    linkedinCompany: "VP Engineering at Example Corp",
    linkedinLocation: "City A, Country A",
    experienceYears: 12,
    extractedCompany: "Example Corp",
    overallConfidence: 91,
    outreachSubject: "quick note on your engineering org",
    outreachEmail:
      "Hi {first_name},\n\nNoticed you've been scaling Example Corp's engineering team. Congrats on the recent growth.\n\nI work with VP Engs going from 50 to 200 people, mostly on hiring loops and on-call ergonomics. Curious whether either of those shows up on your list right now.\n\nWould you be open to a 15-minute swap of notes next week?\n\nThanks,\n{your_name}",
    outreachLinkedinDm:
      "Hi {first_name} — saw your work scaling Example Corp's eng org. I help VPs in similar shapes; open to a 15-min chat next week?",
  },
  {
    name: "Sample Lead 2",
    email: "lead-2@example.com",
    phone: undefined,
    linkedin: "https://www.linkedin.com/in/sample-lead-2",
    github: "https://github.com/sample-lead-2",
    twitter: undefined,
    linkedinCompany: "Founder & CTO at Sample Ventures",
    linkedinLocation: "City B, Country B",
    experienceYears: 8,
    extractedCompany: "Sample Ventures",
    overallConfidence: 84,
    outreachSubject: "your team's recent product launch",
    outreachEmail:
      "Hi {first_name},\n\nSaw the recent launch from Sample Ventures — the architecture choices in your engineering blog stood out as genuinely well-thought-out.\n\nI've been comparing notes with founders building similar infrastructure, mostly around scaling reliability and incident response. Would value your perspective.\n\nDo you have 15 minutes this or next week?\n\nThanks,\n{your_name}",
    outreachLinkedinDm:
      "Hey {first_name} — really liked the recent Sample Ventures launch. Comparing notes with founders this month; open to a quick 15-min chat?",
  },
  {
    name: "Sample Lead 3",
    email: undefined,
    phone: "+0 00000 00000",
    linkedin: "https://www.linkedin.com/in/sample-lead-3",
    github: undefined,
    twitter: "https://x.com/sample_lead_3",
    linkedinCompany: "Senior PM at Demo Labs",
    linkedinLocation: "City C, Country C",
    experienceYears: 6,
    extractedCompany: "Demo Labs",
    overallConfidence: 73,
    outreachSubject: "demo labs onboarding redesign",
    outreachEmail:
      "Hi {first_name},\n\nCame across your recent post on the Demo Labs onboarding redesign — the segmented user flow is a pattern I haven't seen done well before.\n\nI'm collecting notes from PMs who own activation funnels and would love to compare what's working and what isn't.\n\nWould a 15-minute call next week be doable?\n\nThanks,\n{your_name}",
    outreachLinkedinDm:
      "Hi {first_name} — your Demo Labs onboarding redesign post stuck with me. Talking to activation PMs this month; open to 15 min?",
  },
  {
    name: "Sample Lead 4 (low-signal)",
    email: "lead-4@example.com",
    phone: undefined,
    overallConfidence: 12,
    error: "No confident profile match found",
  },
];

const html = buildHtmlPreview(demoRows, {
  generatedAt: new Date("2026-05-09T12:00:00Z"),
  totalRows: demoRows.length,
  successRows: demoRows.filter((row) => !row.error).length,
  failedRows: demoRows.filter((row) => row.error).length,
  brief:
    "Cold-intro outreach for engineering leaders and founders. Warm tone, single ask: 15-minute call. (Illustrative — not a real campaign.)",
  model: "llama-3.3-70b-versatile",
  notice:
    "SAMPLE PREVIEW — This is a synthetic illustration of the bulk-enrichment output. All names, companies, emails, and outreach drafts on this page are placeholders. They are not real people and not real LLM output. Run /leadfind on a real CSV to see the actual product.",
});

await writeFile(outputPath, html, "utf8");
console.log(`Wrote ${outputPath}`);
