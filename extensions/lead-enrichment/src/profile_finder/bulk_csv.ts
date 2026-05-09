export type BulkLeadInput = {
  name: string;
  email?: string;
  phone?: string;
};

export type BulkLeadOutput = {
  name: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  linkedinOption1?: string;
  linkedinOption2?: string;
  linkedinOption3?: string;
  github?: string;
  twitter?: string;
  linkedinCompany?: string;
  linkedinLocation?: string;
  experienceYears?: number;
  extractedCompany?: string;
  linkedinSource?: string;
  githubSource?: string;
  twitterSource?: string;
  companySource?: string;
  companyConfidence?: number;
  overallConfidence?: number;
  resultSource?: string;
  outreachSubject?: string;
  outreachEmail?: string;
  outreachLinkedinDm?: string;
  outreachError?: string;
  note?: string;
  error?: string;
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function toOptional(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  // Treat common null-placeholder values as missing
  if (trimmed.length === 0 || trimmed.toUpperCase() === "NA" || trimmed === "-") return undefined;
  return trimmed;
}

function csvEscape(value: unknown): string {
  const raw = value == null ? "" : String(value);
  if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

function toCsvRow(values: unknown[]): string {
  return values.map((value) => csvEscape(value)).join(",");
}

export function parseLeadsCsv(csvText: string): BulkLeadInput[] {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((value) => normalizeHeader(value));
  const nameIndex = header.findIndex(
    (value) => ["name", "fullname"].includes(value) || value.includes("name"),
  );
  const emailIndex = header.findIndex(
    (value) => ["email", "emailaddress", "mail"].includes(value) || value.includes("email"),
  );
  const phoneIndex = header.findIndex(
    (value) =>
      ["phone", "mobile", "phonenumber", "mobilephone"].includes(value) ||
      value.includes("phone") ||
      value.includes("mobile"),
  );

  const hasHeader = nameIndex >= 0 || emailIndex >= 0 || phoneIndex >= 0;
  const start = hasHeader ? 1 : 0;

  const leads: BulkLeadInput[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const cells = parseCsvLine(lines[index]);
    const name = toOptional(hasHeader ? cells[nameIndex] : cells[0]);
    if (!name) continue;

    const email = toOptional(hasHeader ? cells[emailIndex] : cells[1]);
    const phone = toOptional(hasHeader ? cells[phoneIndex] : cells[2]);

    leads.push({ name, email, phone });
  }

  return leads;
}

export function formatEnrichedLeadsCsv(rows: BulkLeadOutput[]): string {
  const lines: string[] = [];
  lines.push(
    toCsvRow([
      "Name",
      "Email",
      "Phone",
      "LinkedIn",
      "LinkedIn Option 1",
      "LinkedIn Option 2",
      "LinkedIn Option 3",
      "GitHub",
      "Twitter",
      "LinkedIn Company",
      "LinkedIn Location",
      "Experience Years",
      "Extracted Company",
      "LinkedIn Source",
      "GitHub Source",
      "Twitter Source",
      "Company Source",
      "Company Confidence",
      "Overall Confidence",
      "Result Source",
      "Outreach Subject",
      "Outreach Email",
      "Outreach LinkedIn DM",
      "Outreach Error",
      "Note",
      "Error",
    ]),
  );

  for (const row of rows) {
    lines.push(
      toCsvRow([
        row.name,
        row.email,
        row.phone,
        row.linkedin,
        row.linkedinOption1,
        row.linkedinOption2,
        row.linkedinOption3,
        row.github,
        row.twitter,
        row.linkedinCompany,
        row.linkedinLocation,
        row.experienceYears,
        row.extractedCompany,
        row.linkedinSource,
        row.githubSource,
        row.twitterSource,
        row.companySource,
        row.companyConfidence,
        row.overallConfidence,
        row.resultSource,
        row.outreachSubject,
        row.outreachEmail,
        row.outreachLinkedinDm,
        row.outreachError,
        row.note,
        row.error,
      ]),
    );
  }

  return `${lines.join("\n")}\n`;
}
