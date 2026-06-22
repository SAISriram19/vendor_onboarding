/* Instant client-side field validation — a faithful TS port of app/validators.py.
 *
 * This gives zero-latency feedback as the user types. The Python backend re-runs
 * the SAME rules at submit time as the source of truth (it also does the things
 * the client can't: real PDF cross-checks, duplicate/blocklist lookups, AI draft).
 * Keeping the two in sync is intentional and worth calling out in the interview. */

export type Severity = "ok" | "low" | "high" | "critical";
export type FieldStatus = "idle" | "ok" | "warn" | "bad";

export interface Submission {
  legal_name: string;
  country: string;
  tax_id: string;
  bank_name: string;
  account_name: string;
  iban: string;
  contact_email: string;
}

export const COUNTRIES: Record<string, string> = {
  DE: "Germany", US: "United States", GB: "United Kingdom", FR: "France",
  IN: "India", AU: "Australia", NL: "Netherlands",
};

const TAX_ID_FORMATS: Record<string, [string, RegExp]> = {
  US: ["EIN (xx-xxxxxxx)", /^\d{2}-?\d{7}$/],
  GB: ["UK VAT (GB + 9 digits)", /^GB\d{9}$/i],
  DE: ["German VAT (DE + 9 digits)", /^DE\d{9}$/i],
  FR: ["French VAT (FR + 2 + 9 digits)", /^FR[A-Z0-9]{2}\d{9}$/i],
  IN: ["India GSTIN (15 chars)", /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i],
  AU: ["Australian ABN (11 digits)", /^\d{11}$/],
  NL: ["Dutch VAT (NL + 9 digits + B + 2)", /^NL\d{9}B\d{2}$/i],
};

// Full ISO 13616 / SWIFT IBAN length registry.
const IBAN_LENGTHS: Record<string, number> = {
  AL: 28, AD: 24, AT: 20, AZ: 28, BH: 22, BE: 16, BA: 20, BR: 29, BG: 22, CR: 22,
  HR: 21, CY: 28, CZ: 24, DK: 18, DO: 28, EE: 20, EG: 29, FO: 18, FI: 18, FR: 27,
  GE: 22, DE: 22, GI: 23, GR: 27, GL: 18, GT: 28, HU: 28, IS: 26, IE: 22, IL: 23,
  IT: 27, JO: 30, KZ: 20, KW: 30, LV: 21, LB: 28, LI: 21, LT: 20, LU: 20, MK: 19,
  MT: 31, MR: 27, MU: 30, MC: 27, MD: 24, ME: 22, NL: 18, NO: 15, PK: 24, PS: 29,
  PL: 28, PT: 25, QA: 29, RO: 24, SM: 27, SA: 24, RS: 22, SK: 24, SI: 19, ES: 24,
  SE: 24, CH: 21, TN: 24, TR: 26, AE: 23, GB: 22, VG: 24, NG: 28,
};

// GSTIN check digit — Luhn mod-36 (GSTN spec). Catches a single mistyped char.
const GSTIN_CP = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function gstinChecksumOk(g: string): boolean {
  g = (g || "").toUpperCase();
  if (g.length !== 15) return false;
  let factor = 2, total = 0;
  for (let i = 13; i >= 0; i--) {
    const d = factor * GSTIN_CP.indexOf(g[i]);
    factor = factor === 2 ? 1 : 2;
    total += Math.floor(d / 36) + (d % 36);
  }
  return GSTIN_CP[(36 - (total % 36)) % 36] === g[14];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const LEGAL_SUFFIXES = new Set([
  "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc", "gmbh", "ag",
  "sarl", "sas", "bv", "pty", "co", "corp", "company", "pvt", "private", "and", "the",
]);

export interface Check {
  ok: boolean;
  status: FieldStatus;
  severity: Severity;
  message: string;
}

const mk = (ok: boolean, status: FieldStatus, severity: Severity, message: string): Check =>
  ({ ok, status, severity, message });

export function validateTaxId(country: string, taxId: string): Check {
  if (!taxId) return mk(false, "idle", "low", "tax ID missing");
  const cc = (country || "").toUpperCase();
  const fmt = TAX_ID_FORMATS[cc];
  if (!fmt) return mk(true, "ok", "ok", `no format rule for ${cc} — accepted`);
  const [label, rx] = fmt;
  if (rx.test(taxId.trim())) {
    if (cc === "IN" && !gstinChecksumOk(taxId))
      return mk(false, "bad", "low", "GSTIN shape is valid but the check digit is wrong (likely a typo)");
    return mk(true, "ok", "ok", `matches ${label}`);
  }
  for (const [other, [lbl, orx]] of Object.entries(TAX_ID_FORMATS)) {
    if (other !== cc && orx.test(taxId.trim()))
      return mk(false, "bad", "high", `looks like ${lbl} but vendor claims ${cc}`);
  }
  return mk(false, "bad", "low", `does not match expected ${label}`);
}

function ibanMod97(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = parseInt(ch, 36); // 0-9, a-z -> 0..35
    remainder = (remainder * (v > 9 ? 100 : 10) + v) % 97;
  }
  return remainder === 1;
}

export function validateIban(iban: string): Check & { cc: string | null } {
  if (!iban) return { ...mk(false, "idle", "low", "IBAN missing"), cc: null };
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s))
    return { ...mk(false, "bad", "low", "IBAN structure invalid"), cc: null };
  const cc = s.slice(0, 2);
  const expected = IBAN_LENGTHS[cc];
  if (expected && s.length !== expected)
    return { ...mk(false, "bad", "low", `length ${s.length} != ${expected} for ${cc}`), cc };
  if (!ibanMod97(s))
    return { ...mk(false, "bad", "low", "IBAN checksum (mod-97) failed"), cc };
  return { ...mk(true, "ok", "ok", `valid IBAN (${cc})`), cc };
}

export function validateEmail(email: string): Check {
  if (!email) return mk(false, "idle", "low", "email missing");
  return EMAIL_RE.test(email.trim())
    ? mk(true, "ok", "ok", "valid")
    : mk(false, "bad", "low", "email format invalid");
}

export function normalizeName(name: string): string {
  if (!name) return "";
  const s = name.toLowerCase().replace(/[^\w\s]/g, " ");
  return s.split(/\s+/).filter((t) => t && !LEGAL_SUFFIXES.has(t)).join(" ");
}

// difflib.SequenceMatcher.ratio() — same algorithm Python uses.
// Entity-name similarity via the token-set-ratio algorithm (RapidFuzz/FuzzyWuzzy):
// order-independent and subset-aware. "Google" vs "Google India Private Limited"
// ~1.0; unrelated names low. Mirrors app/validators.py name_similarity().
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  const ta = new Set(na.split(" ")), tb = new Set(nb.split(" "));
  const inter = [...ta].filter((t) => tb.has(t)).sort();
  const d1 = [...ta].filter((t) => !tb.has(t)).sort();
  const d2 = [...tb].filter((t) => !ta.has(t)).sort();
  const t0 = inter.join(" ");
  const t1 = [...inter, ...d1].join(" ").trim();
  const t2 = [...inter, ...d2].join(" ").trim();
  return Math.max(ratio(t0, t1), ratio(t0, t2), ratio(t1, t2));
}

function ratio(a: string, b: string): number {
  // matching-blocks ratio: 2*M / T (M = total matched chars)
  const matches = matchingChars(a, b);
  const total = a.length + b.length;
  return total ? (2 * matches) / total : 0;
}
function matchingChars(a: string, b: string): number {
  // recursive longest-matching-block, mirrors difflib
  if (!a || !b) return 0;
  let bestI = 0, bestJ = 0, bestSize = 0;
  const j2len: Record<number, number> = {};
  for (let i = 0; i < a.length; i++) {
    const newj2len: Record<number, number> = {};
    for (let j = 0; j < b.length; j++) {
      if (a[i] === b[j]) {
        const k = (j > 0 ? j2len[j - 1] || 0 : 0) + 1;
        newj2len[j] = k;
        if (k > bestSize) { bestI = i - k + 1; bestJ = j - k + 1; bestSize = k; }
      }
    }
    for (const key in j2len) delete j2len[key];
    Object.assign(j2len, newj2len);
  }
  if (bestSize === 0) return 0;
  return (
    bestSize +
    matchingChars(a.slice(0, bestI), b.slice(0, bestJ)) +
    matchingChars(a.slice(bestI + bestSize), b.slice(bestJ + bestSize))
  );
}

export interface FieldResult { key: string; label: string; check: Check; }

/** Run all instant (field-only) checks. Returns per-field results + worst severity. */
export function evaluateFields(s: Submission): {
  results: FieldResult[];
  nameMatch: Check;
  ibanCountry: Check | null;
  worst: Severity;
  preview: "APPROVED" | "PENDING" | "REJECTED" | "INCOMPLETE";
} {
  const iban = validateIban(s.iban);
  const results: FieldResult[] = [
    { key: "tax_id", label: "Tax ID format", check: validateTaxId(s.country, s.tax_id) },
    { key: "contact_email", label: "Contact email", check: validateEmail(s.contact_email) },
    { key: "iban", label: "IBAN validity", check: iban },
  ];

  const sim = nameSimilarity(s.legal_name, s.account_name);
  let nameMatch: Check;
  if (!s.legal_name || !s.account_name) nameMatch = mk(false, "idle", "low", "—");
  else if (sim >= 0.85) nameMatch = mk(true, "ok", "ok", `Names match (${pct(sim)})`);
  else if (sim >= 0.6) nameMatch = mk(false, "warn", "high", `Partial match (${pct(sim)}) — review`);
  else nameMatch = mk(false, "bad", "high", `Account holder ≠ vendor (${pct(sim)}) — fraud risk`);

  let ibanCountry: Check | null = null;
  const country = (s.country || "").toUpperCase();
  if (iban.cc && country) {
    ibanCountry = iban.cc !== country
      ? mk(false, "bad", "high", `IBAN registered in ${iban.cc} but vendor claims ${country}`)
      : mk(true, "ok", "ok", `IBAN country (${iban.cc}) matches`);
  }

  const required: (keyof Submission)[] =
    ["legal_name", "country", "tax_id", "bank_name", "account_name", "iban", "contact_email"];
  const incomplete = required.some((k) => !s[k]);

  const all = [...results.map((r) => r.check), nameMatch, ...(ibanCountry ? [ibanCountry] : [])];
  const rank: Record<Severity, number> = { ok: 0, low: 1, high: 2, critical: 3 };
  const worst = all.reduce<Severity>(
    (w, c) => (c.status !== "idle" && rank[c.severity] > rank[w] ? c.severity : w),
    "ok",
  );

  let preview: "APPROVED" | "PENDING" | "REJECTED" | "INCOMPLETE";
  if (incomplete) preview = "INCOMPLETE";
  else if (worst === "critical") preview = "REJECTED";
  else if (worst === "high" || worst === "low") preview = "PENDING";
  else preview = "APPROVED";

  return { results, nameMatch, ibanCountry, worst, preview };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
