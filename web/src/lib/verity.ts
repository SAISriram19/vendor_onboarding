/* Verity's live "brain": turns the in-progress form + document scans + reference
 * data (known vendors, blocklist) into a verdict, progress, and the reviewer
 * (Vera)'s mood + spoken line. Field rules come from validators.ts (kept in sync
 * with the Python backend). Duplicate/blocklist are checked client-side against
 * the REAL backend data (/api/vendors, /api/blocklist) — not faked. */

import {
  evaluateFields, normalizeName, nameSimilarity, type Submission, type FieldStatus,
} from "./validators";
import type { ScanResult, KnownVendor, BlockEntry } from "./api";

export type Mood = "idle" | "thinking" | "happy" | "worried" | "alarmed";
export type Verdict = "APPROVED" | "PENDING" | "REJECTED" | "INCOMPLETE";

export interface RefData { vendors: KnownVendor[]; blocklist: BlockEntry[]; }
export interface DocState { file: File | null; scanning: boolean; result: ScanResult | null; }
export type Docs = { bank_letter: DocState; incorporation_doc: DocState };

const normIban = (s: string) => (s || "").replace(/\s/g, "").toUpperCase();

export interface RiskHit { kind: "duplicate" | "blocklist"; message: string; says: string; }

/** Real duplicate-IBAN / blocklist check against backend reference data. */
export function riskHit(s: Submission, ref: RefData): RiskHit | null {
  const subIban = normIban(s.iban);
  if (subIban) {
    const dup = ref.vendors.find(
      (v) => normIban(v.iban) === subIban && nameSimilarity(v.legal_name, s.legal_name) < 0.85,
    );
    if (dup) return {
      kind: "duplicate",
      message: `IBAN already registered to ${dup.legal_name} (${dup.id}). Hard stop.`,
      says: `This IBAN is already on file for ${dup.legal_name}. Re-using a bank account is a hard stop — verify before paying anyone.`,
    };
  }
  if (s.legal_name && normalizeName(s.legal_name)) {
    const b = ref.blocklist.find((e) => nameSimilarity(e.name, s.legal_name) >= 0.85);
    if (b) return {
      kind: "blocklist",
      message: `Vendor matches blocklist entry: ${b.reason}. Hard stop.`,
      says: `Stop. This vendor matches a sanctions / blocklist entry (${b.reason}). Do not onboard or pay — escalate to compliance.`,
    };
  }
  return null;
}

export interface FieldVM {
  key: keyof Submission; status: FieldStatus; message: string;
}

export interface Live {
  verdict: Verdict;
  pass: number; total: number;
  mood: Mood; moodLabel: string; says: string;
  fields: Record<keyof Submission, { status: FieldStatus; message: string }>;
}

const MOOD_LABEL: Record<Mood, string> = {
  idle: "Standing by", thinking: "Scanning", happy: "Looks clean",
  worried: "Needs a look", alarmed: "Alarmed",
};

const REQUIRED: (keyof Submission)[] =
  ["legal_name", "country", "tax_id", "bank_name", "account_name", "iban", "contact_email"];

export function deriveLive(
  s: Submission, docs: Docs, ref: RefData, touched: Set<keyof Submission>,
): Live {
  const ev = evaluateFields(s);

  // per-field VM
  const fields = {} as Record<keyof Submission, { status: FieldStatus; message: string }>;
  for (const r of ev.results) fields[r.key as keyof Submission] = { status: r.check.status, message: r.check.message };
  fields.account_name = { status: ev.nameMatch.status, message: ev.nameMatch.message === "—" ? "" : ev.nameMatch.message };
  fields.legal_name = { status: s.legal_name ? (s.legal_name.length >= 3 ? "ok" : "warn") : "idle", message: "" };
  fields.bank_name = { status: s.bank_name ? "ok" : "idle", message: "" };
  fields.country = fields.country ?? { status: s.country ? "ok" : "idle", message: "" };

  // Calm validation: a field only shows a NEGATIVE state (warn/bad) once it's been
  // blurred. Until then, suppress to idle so we never scream "fraud risk" mid-type.
  // Positive "ok" still shows live as encouragement. Loading a sample marks all
  // fields touched, so demos light up instantly.
  for (const k of Object.keys(fields) as (keyof Submission)[]) {
    const f = fields[k];
    if ((f.status === "warn" || f.status === "bad") && !touched.has(k)) {
      fields[k] = { status: "idle", message: "" };
    }
  }

  const anyFilled = REQUIRED.some((k) => s[k]);
  const complete = REQUIRED.every((k) => s[k]);
  const scanning = docs.bank_letter.scanning || docs.incorporation_doc.scanning;

  // risk alarms only fire once the driving field is touched (no mid-type panic)
  const rawRisk = riskHit(s, ref);
  const risk = rawRisk && ((rawRisk.kind === "duplicate" && touched.has("iban"))
    || (rawRisk.kind === "blocklist" && touched.has("legal_name"))) ? rawRisk : null;

  // worst severity, computed only from TOUCHED checks (so untouched fields can't
  // drive the verdict while the user is still typing them)
  const rank: Record<string, number> = { ok: 0, low: 1, high: 2, critical: 3 };
  let gatedWorst = "ok";
  const consider = (key: keyof Submission, sev: string) => {
    const e = touched.has(key) ? sev : "ok";
    if (rank[e] > rank[gatedWorst]) gatedWorst = e;
  };
  ev.results.forEach((r) => consider(r.key as keyof Submission, r.check.severity));
  consider("account_name", ev.nameMatch.severity);
  if (ev.ibanCountry) consider("iban", ev.ibanCountry.severity);

  // progress: 5 core checks
  const coreKeys: (keyof Submission)[] = ["legal_name", "country", "tax_id", "iban", "contact_email"];
  const pass = coreKeys.filter((k) => fields[k]?.status === "ok").length;
  const total = coreKeys.length;

  // verdict
  let verdict: Verdict;
  if (risk) verdict = "REJECTED";
  else if (!anyFilled || !complete) verdict = "INCOMPLETE";
  else if (gatedWorst === "critical") verdict = "REJECTED";
  else if (gatedWorst === "high" || gatedWorst === "low") verdict = "PENDING";
  else verdict = "APPROVED";
  // Note: a name mismatch or bad IBAN is PENDING (needs review), NOT auto-rejected —
  // legitimate explanations exist (factoring, trading name, parent pays, sole trader).
  // Only true hard stops with no benign explanation (duplicate account / blocklist)
  // reach REJECTED; those are handled by `risk` above.

  // reviewer mood + line — priority order matches Verity
  let mood: Mood = "idle";
  let says = "";
  const docFail = (["bank_letter", "incorporation_doc"] as const).some(
    (k) => docs[k].result?.checks?.some((c) => c.status === "fail"),
  );

  if (scanning) {
    mood = "thinking";
    says = "Reading the document now — keep going, I'll cross-check it against the form in a second.";
  } else if (risk) {
    mood = "alarmed"; says = risk.says;
  } else if (fields.account_name.status === "bad") {
    mood = "worried";
    says = "The account holder doesn't match the vendor's legal name. Often that's a payment-redirection red flag — but not always: factoring, a trading name, or a parent company paying are all legitimate. I'd hold for review and ask them to either correct the account or send an authorisation / assignment letter.";
  } else if (docFail) {
    mood = "worried";
    says = "The bank letter doesn't match the IBAN on the form. Could be the wrong file attached, or a real discrepancy — worth confirming the account details before paying.";
  } else if (fields.iban.status === "bad") {
    mood = "worried";
    says = "That IBAN doesn't pass its checksum — it's likely mistyped. Worth fixing before we go further.";
  } else if (fields.tax_id?.status === "bad" || fields.tax_id?.status === "warn") {
    mood = "worried";
    says = "The tax ID doesn't fit the country they claim. Could be an honest mistake, but a human should glance at it.";
  } else if (touched.has("iban") && ev.ibanCountry?.status === "bad") {
    mood = "worried";
    says = "Heads up — the IBAN's country doesn't match the vendor's country. Sometimes legitimate, but flag it.";
  } else if (gatedWorst === "high" || gatedWorst === "low") {
    mood = "worried";
    says = "A couple of details need a second look before I'd sign off — nothing alarming yet.";
  } else if (!anyFilled) {
    mood = "idle";
    says = "Load a sample or start typing the vendor's details — I'll check each field as you go.";
  } else if (!complete) {
    mood = "idle";
    says = "Looking good so far. Fill in the remaining fields and I'll give you a verdict.";
  } else {
    mood = "happy";
    says = "Everything lines up — name, tax ID, IBAN and contact all check out. This vendor looks clean to me.";
  }

  return { verdict, pass, total, mood, moodLabel: MOOD_LABEL[mood], says, fields };
}

// shared color tokens (Verity palette)
export const C = {
  ok: "#11855C", warn: "#B7791F", bad: "#D23B36", idle: "#C7C2B6",
  okBg: "#E6F4EE", warnBg: "#FBF4E5", badBg: "#FCEDEC", idleBg: "#F4F2EC",
  okBorder: "#BFE3D2", warnBorder: "#EAD9AE", badBorder: "#F0BFBB", idleBorder: "#E1DDD2",
  purple: "#6B4FC9", purpleLt: "#8A6FE6", ink: "#1E1B26",
};

export function fieldColor(st: FieldStatus) {
  return { ok: C.ok, warn: C.warn, bad: C.bad, idle: C.idle }[st];
}
export function fieldBg(st: FieldStatus) {
  return { ok: "#FFFFFF", warn: "#FFFCF4", bad: "#FFF7F6", idle: "#FFFFFF" }[st];
}
export function fieldBorder(st: FieldStatus) {
  return { ok: C.okBorder, warn: C.warnBorder, bad: C.badBorder, idle: C.idleBorder }[st];
}

export const VERDICT_TONE: Record<Verdict, { color: string; bg: string; border: string }> = {
  APPROVED: { color: C.ok, bg: C.okBg, border: C.okBorder },
  PENDING: { color: C.warn, bg: C.warnBg, border: C.warnBorder },
  REJECTED: { color: C.bad, bg: C.badBg, border: C.badBorder },
  INCOMPLETE: { color: "#8C8794", bg: C.idleBg, border: C.idleBorder },
};

export const MOOD_COLOR: Record<Mood, string> = {
  idle: C.purple, thinking: C.purple, happy: C.ok, worried: "#C77D11", alarmed: C.bad,
};
export const MOOD_SHADOW: Record<Mood, string> = {
  idle: "rgba(107,79,201,.35)", thinking: "rgba(107,79,201,.35)", happy: "rgba(17,133,92,.35)",
  worried: "rgba(199,125,17,.35)", alarmed: "rgba(210,59,54,.4)",
};
export const MOOD_MARK: Record<Mood, { path: string; sw: number }> = {
  idle: { path: "M7 12h0.01 M12 12h0.01 M17 12h0.01", sw: 2.6 },
  thinking: { path: "M7 12h0.01 M12 12h0.01 M17 12h0.01", sw: 2.6 },
  happy: { path: "M6 12.6l3.6 3.7L18 8", sw: 2.5 },
  worried: { path: "M12 6.5v7.2 M12 17.4h0.01", sw: 2.5 },
  alarmed: { path: "M8 8l8 8 M16 8l-8 8", sw: 2.7 },
};
