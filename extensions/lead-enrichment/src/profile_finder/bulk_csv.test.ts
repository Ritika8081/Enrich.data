import { describe, it, expect } from "vitest";
import { formatEnrichedLeadsCsv, parseLeadsCsv } from "./bulk_csv.js";

describe("parseLeadsCsv", () => {
  it("parses standard Name,Email,Phone header", () => {
    const csv =
      "Name,Email,Phone\nAlice,alice@example.com,123456789\nBob,bob@example.com,987654321";
    const leads = parseLeadsCsv(csv);
    expect(leads).toHaveLength(2);
    expect(leads[0]).toEqual({ name: "Alice", email: "alice@example.com", phone: "123456789" });
    expect(leads[1]).toEqual({ name: "Bob", email: "bob@example.com", phone: "987654321" });
  });

  it("parses lead_name / lead_phone_no / lead_data.lead_email_title headers with leading empty columns", () => {
    const csv =
      ",,,,,lead_name,lead_phone_no,lead_data.lead_email_title\n" +
      ",,,,,Anwar,60182345678,\n" +
      ",,,,,Hazibah Mustapha,177710325,myinsaka@gmail.com\n" +
      ",,,,,Da min,1161921246,mmyitmyit49@gmail.com";
    const leads = parseLeadsCsv(csv);
    expect(leads).toHaveLength(3);
    expect(leads[0]).toEqual({ name: "Anwar", phone: "60182345678", email: undefined });
    expect(leads[1]).toEqual({
      name: "Hazibah Mustapha",
      phone: "177710325",
      email: "myinsaka@gmail.com",
    });
    expect(leads[2]).toEqual({
      name: "Da min",
      phone: "1161921246",
      email: "mmyitmyit49@gmail.com",
    });
  });

  it("treats NA as a missing email value", () => {
    const csv =
      ",,,,,lead_name,lead_phone_no,lead_data.lead_email_title\n" +
      ",,,,,kayla lee su yong,149038994,NA\n" +
      ",,,,,Latip,198082598,NA";
    const leads = parseLeadsCsv(csv);
    expect(leads).toHaveLength(2);
    expect(leads[0].email).toBeUndefined();
    expect(leads[1].email).toBeUndefined();
  });

  it("treats - as a missing value", () => {
    const csv = "Name,Email,Phone\nCharlie,-,555000111";
    const leads = parseLeadsCsv(csv);
    expect(leads[0].email).toBeUndefined();
  });

  it("skips rows with empty name", () => {
    const csv = "Name,Email,Phone\n,alice@example.com,123\nBob,,456";
    const leads = parseLeadsCsv(csv);
    expect(leads).toHaveLength(1);
    expect(leads[0].name).toBe("Bob");
  });

  it("falls back to positional columns when no recognized header present", () => {
    const csv = "Alice,alice@example.com,123456789\nBob,bob@example.com,987654321";
    const leads = parseLeadsCsv(csv);
    expect(leads).toHaveLength(2);
    expect(leads[0]).toEqual({ name: "Alice", email: "alice@example.com", phone: "123456789" });
  });
});

describe("formatEnrichedLeadsCsv", () => {
  it("includes top 3 LinkedIn option columns", () => {
    const csv = formatEnrichedLeadsCsv([
      {
        name: "Firdaus",
        email: "firdauseet23.msq@gmail.com",
        phone: "129318316",
        linkedin: "https://www.linkedin.com/in/firdaus-1",
        linkedinOption1: "https://www.linkedin.com/in/firdaus-1",
        linkedinOption2: "https://www.linkedin.com/in/firdaus-2",
        linkedinOption3: "https://www.linkedin.com/in/firdaus-3",
        overallConfidence: 40,
      },
    ]);

    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("LinkedIn Option 1");
    expect(lines[0]).toContain("LinkedIn Option 2");
    expect(lines[0]).toContain("LinkedIn Option 3");
    expect(lines[0]).toContain("LinkedIn Source");
    expect(lines[0]).toContain("GitHub Source");
    expect(lines[0]).toContain("Twitter Source");
    expect(lines[0]).toContain("Company Source");
    expect(lines[1]).toContain("https://www.linkedin.com/in/firdaus-1");
    expect(lines[1]).toContain("https://www.linkedin.com/in/firdaus-2");
    expect(lines[1]).toContain("https://www.linkedin.com/in/firdaus-3");
  });
});
