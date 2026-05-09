import type { BulkLeadOutput } from "../profile_finder/bulk_csv.js";

export type HtmlPreviewMeta = {
  generatedAt?: Date;
  totalRows: number;
  successRows: number;
  failedRows: number;
  brief?: string;
  model?: string;
  notice?: string;
};

function escapeHtml(value: string | number | undefined | null): string {
  if (value == null) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function profileLinks(row: BulkLeadOutput): string {
  const links: string[] = [];
  if (row.linkedin) {
    links.push(
      `<a href="${escapeHtml(row.linkedin)}" target="_blank" rel="noopener" class="link linkedin">LinkedIn</a>`,
    );
  }
  if (row.github) {
    links.push(
      `<a href="${escapeHtml(row.github)}" target="_blank" rel="noopener" class="link github">GitHub</a>`,
    );
  }
  if (row.twitter) {
    links.push(
      `<a href="${escapeHtml(row.twitter)}" target="_blank" rel="noopener" class="link twitter">Twitter / X</a>`,
    );
  }
  return links.length > 0
    ? `<div class="links">${links.join("")}</div>`
    : '<div class="links empty">no public profiles found</div>';
}

function confidenceBar(value: number | undefined): string {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const tone = pct >= 75 ? "high" : pct >= 40 ? "mid" : "low";
  return `<div class="confidence ${tone}" title="Overall match confidence">
    <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
    <span class="value">${pct}%</span>
  </div>`;
}

function leadCard(row: BulkLeadOutput, index: number): string {
  const name = row.name || "(unnamed)";
  const role = row.linkedinCompany || row.extractedCompany || row.companySource || "";
  const location = row.linkedinLocation || "";
  const subtitle = [role, location].filter(Boolean).join(" • ");
  const hue = avatarHue(name);
  const hasOutreach = Boolean(row.outreachEmail && row.outreachLinkedinDm);

  const outreachBlock = hasOutreach
    ? `<div class="outreach">
        <div class="outreach-tabs">
          <button class="tab active" data-tab="email-${index}">Email</button>
          <button class="tab" data-tab="dm-${index}">LinkedIn DM</button>
        </div>
        <div class="tab-panel active" id="email-${index}">
          <div class="subject">
            <span class="label">Subject</span>
            <span class="text">${escapeHtml(row.outreachSubject)}</span>
          </div>
          <pre class="body">${escapeHtml(row.outreachEmail)}</pre>
          <button class="copy" data-copy="email-body-${index}">Copy email</button>
          <textarea hidden id="email-body-${index}">${escapeHtml(`Subject: ${row.outreachSubject ?? ""}\n\n${row.outreachEmail ?? ""}`)}</textarea>
        </div>
        <div class="tab-panel" id="dm-${index}">
          <pre class="body">${escapeHtml(row.outreachLinkedinDm)}</pre>
          <button class="copy" data-copy="dm-body-${index}">Copy DM</button>
          <textarea hidden id="dm-body-${index}">${escapeHtml(row.outreachLinkedinDm ?? "")}</textarea>
        </div>
      </div>`
    : row.outreachError
      ? `<div class="outreach skipped">Outreach generation failed: ${escapeHtml(row.outreachError)}</div>`
      : `<div class="outreach skipped">No outreach generated. Set <code>GROQ_API_KEY</code> and pass <code>--brief "..."</code> to enable.</div>`;

  const errorBlock = row.error
    ? `<div class="row-error">⚠ ${escapeHtml(row.error)}</div>`
    : "";

  return `<article class="card">
    <header>
      <div class="avatar" style="background:hsl(${hue} 60% 45%)">${escapeHtml(initials(name))}</div>
      <div class="who">
        <h2>${escapeHtml(name)}</h2>
        <div class="subtitle">${escapeHtml(subtitle) || "<span class='muted'>no role/company found</span>"}</div>
        ${row.email ? `<div class="contact">${escapeHtml(row.email)}</div>` : ""}
      </div>
      ${confidenceBar(row.overallConfidence)}
    </header>
    ${profileLinks(row)}
    ${errorBlock}
    ${outreachBlock}
  </article>`;
}

const STYLES = `
:root {
  --bg: #0d1117;
  --panel: #161b22;
  --panel-2: #1f2630;
  --border: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
  --accent: #58a6ff;
  --good: #3fb950;
  --mid: #d29922;
  --low: #f85149;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 32px 24px 64px; }
header.page { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
header.page h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; }
header.page .sub { color: var(--muted); font-size: 13px; }
.stats { display: flex; gap: 12px; flex-wrap: wrap; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px 14px; min-width: 100px; }
.stat .n { font-size: 20px; font-weight: 600; }
.stat.good .n { color: var(--good); }
.stat.bad .n { color: var(--low); }
.stat .l { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.brief { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; margin-bottom: 24px; }
.brief .l { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px; }
.brief code { background: var(--panel-2); padding: 2px 5px; border-radius: 3px; font-size: 12px; }
.notice { background: rgba(210, 153, 34, 0.12); border: 1px solid rgba(210, 153, 34, 0.4); color: #f0c674; border-radius: 6px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
.notice strong { color: #ffd58a; }
.grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
@media (min-width: 760px) { .grid { grid-template-columns: 1fr 1fr; } }
@media (min-width: 1100px) { .grid { grid-template-columns: 1fr 1fr 1fr; } }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.card header { display: grid; grid-template-columns: 48px 1fr auto; gap: 12px; align-items: center; }
.avatar { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; color: white; font-weight: 600; }
.who h2 { margin: 0; font-size: 16px; }
.who .subtitle { font-size: 12px; color: var(--muted); }
.who .contact { font-size: 11px; color: var(--muted); margin-top: 2px; }
.confidence { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 60px; }
.confidence .bar { width: 50px; height: 4px; background: var(--panel-2); border-radius: 2px; overflow: hidden; }
.confidence .fill { height: 100%; }
.confidence.high .fill { background: var(--good); }
.confidence.mid .fill { background: var(--mid); }
.confidence.low .fill { background: var(--low); }
.confidence .value { font-size: 11px; color: var(--muted); }
.links { display: flex; flex-wrap: wrap; gap: 6px; }
.links.empty { color: var(--muted); font-size: 12px; font-style: italic; }
.link { font-size: 11px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 12px; text-decoration: none; color: var(--accent); }
.link:hover { background: var(--panel-2); }
.row-error { font-size: 12px; color: var(--low); background: rgba(248,81,73,0.08); border: 1px solid rgba(248,81,73,0.2); border-radius: 4px; padding: 6px 10px; }
.outreach { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.outreach.skipped { padding: 10px 12px; color: var(--muted); font-size: 12px; }
.outreach.skipped code { background: var(--bg); padding: 1px 4px; border-radius: 3px; }
.outreach-tabs { display: flex; border-bottom: 1px solid var(--border); }
.outreach .tab { flex: 1; background: transparent; color: var(--muted); border: none; padding: 8px 12px; font-size: 12px; cursor: pointer; }
.outreach .tab.active { color: var(--text); background: var(--panel); border-bottom: 2px solid var(--accent); margin-bottom: -1px; }
.tab-panel { display: none; padding: 12px; }
.tab-panel.active { display: block; }
.subject { display: flex; gap: 8px; align-items: baseline; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px dashed var(--border); }
.subject .label { font-size: 10px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.05em; }
.subject .text { font-size: 13px; font-weight: 500; }
.body { background: transparent; color: var(--text); margin: 0; padding: 0; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-wrap: break-word; }
.copy { margin-top: 10px; font-size: 11px; padding: 4px 10px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.copy:hover { border-color: var(--accent); color: var(--accent); }
.copy.copied { color: var(--good); border-color: var(--good); }
.muted { color: var(--muted); }
footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
`;

const SCRIPT = `
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.classList.contains("tab")) {
    const tabId = target.dataset.tab;
    if (!tabId) return;
    const card = target.closest(".outreach");
    if (!card) return;
    card.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    card.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    target.classList.add("active");
    const panel = card.querySelector("#" + tabId);
    if (panel) panel.classList.add("active");
  }
  if (target.classList.contains("copy")) {
    const id = target.dataset.copy;
    if (!id) return;
    const ta = document.getElementById(id);
    if (!(ta instanceof HTMLTextAreaElement)) return;
    navigator.clipboard.writeText(ta.value).then(() => {
      target.classList.add("copied");
      const original = target.textContent;
      target.textContent = "Copied ✓";
      setTimeout(() => {
        target.classList.remove("copied");
        target.textContent = original;
      }, 1500);
    }).catch(() => {});
  }
});
`;

export function buildHtmlPreview(rows: BulkLeadOutput[], meta: HtmlPreviewMeta): string {
  const generatedAt = (meta.generatedAt ?? new Date()).toISOString();
  const cards = rows.map((row, index) => leadCard(row, index)).join("\n");
  const noticeBlock = meta.notice
    ? `<div class="notice">${escapeHtml(meta.notice)}</div>`
    : "";
  const briefBlock = meta.brief
    ? `<div class="brief"><div class="l">Campaign brief</div><div>${escapeHtml(meta.brief)}</div></div>`
    : "";
  const modelBlock = meta.model
    ? `<span class="sub">Model: <code>${escapeHtml(meta.model)}</code></span>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lead Enrichment — ${rows.length} leads</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header class="page">
    <div>
      <h1>Lead Enrichment Results</h1>
      <div class="sub">Generated ${escapeHtml(generatedAt)} ${modelBlock ? "· " + modelBlock : ""}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="n">${meta.totalRows}</div><div class="l">Total</div></div>
      <div class="stat good"><div class="n">${meta.successRows}</div><div class="l">Enriched</div></div>
      <div class="stat bad"><div class="n">${meta.failedRows}</div><div class="l">Failed</div></div>
    </div>
  </header>
  ${noticeBlock}
  ${briefBlock}
  <div class="grid">
    ${cards}
  </div>
  <footer>
    Built on top of <a href="https://github.com/openclaw/openclaw" style="color: var(--accent)">OpenClaw</a> · Lead Enrichment plugin
  </footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
