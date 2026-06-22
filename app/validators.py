"""Deterministic validation primitives: tax IDs, IBAN, email, name matching.

These are pure functions with no I/O so they're easy to reason about and test,
and so the decision logic stays explainable in the interview.
"""
import re
from difflib import SequenceMatcher

import jellyfish  # phonetic + edit-distance name matching (Soundex/Metaphone/Jaro-Winkler)

# --- Tax ID formats per country -------------------------------------------------
# Keyed by ISO-2 country code. Each entry: (human label, compiled regex).
TAX_ID_FORMATS = {
    "US": ("EIN (xx-xxxxxxx)", re.compile(r"^\d{2}-?\d{7}$")),
    "GB": ("UK VAT (GB + 9 digits)", re.compile(r"^GB\d{9}$", re.I)),
    "DE": ("German VAT (DE + 9 digits)", re.compile(r"^DE\d{9}$", re.I)),
    "FR": ("French VAT (FR + 2 + 9 digits)", re.compile(r"^FR[A-Z0-9]{2}\d{9}$", re.I)),
    "IN": ("India GSTIN (15 chars)", re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$", re.I)),
    "AU": ("Australian ABN (11 digits)", re.compile(r"^\d{11}$")),
    "NL": ("Dutch VAT (NL + 9 digits + B + 2)", re.compile(r"^NL\d{9}B\d{2}$", re.I)),
}

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# IBAN length per country — full ISO 13616 / SWIFT registry.
IBAN_LENGTHS = {
    "AL": 28, "AD": 24, "AT": 20, "AZ": 28, "BH": 22, "BE": 16, "BA": 20, "BR": 29,
    "BG": 22, "CR": 22, "HR": 21, "CY": 28, "CZ": 24, "DK": 18, "DO": 28, "EE": 20,
    "EG": 29, "FO": 18, "FI": 18, "FR": 27, "GE": 22, "DE": 22, "GI": 23, "GR": 27,
    "GL": 18, "GT": 28, "HU": 28, "IS": 26, "IE": 22, "IL": 23, "IT": 27, "JO": 30,
    "KZ": 20, "KW": 30, "LV": 21, "LB": 28, "LI": 21, "LT": 20, "LU": 20, "MK": 19,
    "MT": 31, "MR": 27, "MU": 30, "MC": 27, "MD": 24, "ME": 22, "NL": 18, "NO": 15,
    "PK": 24, "PS": 29, "PL": 28, "PT": 25, "QA": 29, "RO": 24, "SM": 27, "SA": 24,
    "RS": 22, "SK": 24, "SI": 19, "ES": 24, "SE": 24, "CH": 21, "TN": 24, "TR": 26,
    "AE": 23, "GB": 22, "VG": 24, "NG": 28,
}

# GSTIN check digit — Luhn mod-36 (per GSTN spec). The 15th char makes the whole
# number self-validating, so a single mistyped char is caught.
_GSTIN_CP = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_check_char(first14):
    factor, total = 2, 0
    for ch in reversed(first14):
        d = factor * _GSTIN_CP.index(ch)
        factor = 1 if factor == 2 else 2
        total += (d // 36) + (d % 36)
    return _GSTIN_CP[(36 - (total % 36)) % 36]


def gstin_checksum_ok(g):
    g = (g or "").upper()
    return len(g) == 15 and gstin_check_char(g[:14]) == g[14]

# Common legal suffixes stripped before comparing company names.
_LEGAL_SUFFIXES = [
    "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc",
    "gmbh", "ag", "sarl", "sas", "bv", "pty", "co", "corp", "company",
    "pvt", "private", "and", "the",
]


def validate_tax_id(country, tax_id):
    """Return (ok, message). Checks the ID matches the stated country's format."""
    if not tax_id:
        return False, "tax ID missing"
    country = (country or "").upper()
    fmt = TAX_ID_FORMATS.get(country)
    if not fmt:
        return True, f"no format rule for {country} — accepted without format check"
    label, rx = fmt
    if rx.match(tax_id.strip()):
        # India: the regex only checks shape — also verify the mod-36 check digit.
        if country == "IN" and not gstin_checksum_ok(tax_id):
            return False, "GSTIN shape is valid but the check digit is wrong (likely a typo)"
        return True, f"matches {label}"
    # Does it look like some OTHER country's format? That's a strong signal.
    for cc, (lbl, other) in TAX_ID_FORMATS.items():
        if cc != country and other.match(tax_id.strip()):
            return False, f"'{tax_id}' looks like {lbl} but vendor claims {country}"
    return False, f"'{tax_id}' does not match expected {label}"


def _iban_mod97(iban):
    """Standard ISO 7064 mod-97 check. Returns True if checksum valid."""
    rearranged = iban[4:] + iban[:4]
    digits = "".join(str(int(c, 36)) for c in rearranged)  # letters -> 10..35
    return int(digits) % 97 == 1


def validate_iban(iban):
    """Return (ok, message, country_code)."""
    if not iban:
        return False, "IBAN missing", None
    s = re.sub(r"\s+", "", iban).upper()
    if not re.match(r"^[A-Z]{2}\d{2}[A-Z0-9]+$", s):
        return False, "IBAN structure invalid", None
    cc = s[:2]
    expected = IBAN_LENGTHS.get(cc)
    if expected and len(s) != expected:
        return False, f"IBAN length {len(s)} != expected {expected} for {cc}", cc
    if not _iban_mod97(s):
        return False, "IBAN checksum (mod-97) failed", cc
    return True, f"valid IBAN ({cc})", cc


def validate_email(email):
    if not email:
        return False, "email missing"
    return (bool(EMAIL_RE.match(email.strip())),
            "valid" if EMAIL_RE.match(email.strip() or "") else "email format invalid")


def normalize_name(name):
    """Lowercase, drop punctuation and legal suffixes, collapse whitespace."""
    if not name:
        return ""
    s = re.sub(r"[^\w\s]", " ", name.lower())
    tokens = [t for t in s.split() if t not in _LEGAL_SUFFIXES]
    return " ".join(tokens)


def _ratio(a, b):
    return SequenceMatcher(None, a, b).ratio()


def name_similarity(a, b):
    """0..1 entity-name similarity via the token-set-ratio algorithm
    (RapidFuzz/FuzzyWuzzy). Order-independent and subset-aware: it splits both
    names into token sets, then compares the shared tokens against each full set,
    so "Google" vs "Google India Private Limited" scores ~1.0 while unrelated
    names score low. Robust to word order, extra words, and minor typos.
    """
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    ta, tb = set(na.split()), set(nb.split())
    if not ta or not tb:
        return 0.0
    inter = sorted(ta & tb)
    t0 = " ".join(inter)
    t1 = " ".join(inter + sorted(ta - tb)).strip()
    t2 = " ".join(inter + sorted(tb - ta)).strip()
    return max(_ratio(t0, t1), _ratio(t0, t2), _ratio(t1, t2))


def sanctions_match(name, blocklist):
    """Screen a vendor name against a sanctions/blocklist using three layers, so
    aliases, transliterations and typos still hit — the way real OFAC/UN screening
    works (exact match alone misses 'Saraswathi' vs 'Saraswati', etc.):
      1. token-set fuzzy ratio  >= 0.85
      2. Jaro-Winkler           >= 0.90  (transliteration / minor spelling)
      3. Metaphone code equality          (sounds-alike)
    Returns the matched entry (with `method`) or None.
    """
    nn = normalize_name(name)
    if not nn:
        return None
    for b in blocklist:
        bn = normalize_name(b.get("name"))
        if not bn:
            continue
        if name_similarity(name, b.get("name")) >= 0.85:
            return {**b, "method": "fuzzy token-set"}
        if jellyfish.jaro_winkler_similarity(nn, bn) >= 0.90:
            return {**b, "method": "Jaro-Winkler"}
        mp = jellyfish.metaphone(nn)
        if mp and mp == jellyfish.metaphone(bn):
            return {**b, "method": "Metaphone (sounds-alike)"}
    return None


def normalize_iban(iban):
    return re.sub(r"\s+", "", (iban or "")).upper()


_IBAN_IN_TEXT = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}\b", re.I)


def find_ibans(text):
    """Pull IBAN-like tokens out of free text (e.g. an OCR'd bank letter)."""
    if not text:
        return []
    out = []
    for m in _IBAN_IN_TEXT.finditer(text):
        cand = normalize_iban(m.group(0))
        ok, _, _ = validate_iban(cand)
        if ok:
            out.append(cand)
    return out


def text_contains_name(text, name):
    """True if all significant tokens of `name` appear in `text` (order-free)."""
    toks = [t for t in normalize_name(name).split() if len(t) > 2]
    if not toks:
        return False
    low = (text or "").lower()
    return all(t in low for t in toks)
