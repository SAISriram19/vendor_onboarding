"""External verification adapters — the "deliberately next" integrations.

OFF by default. Set ENRICH=1 to let a run make these network calls. Everything is
guarded by a short timeout + try/except, so even enabled it degrades to a note
rather than hanging or crashing the run.

Honesty rule: an adapter NEVER fabricates a "verified" result. Free public
services (EU VIES VAT, India IFSC) do real lookups. Services that need a paid /
authenticated provider (penny-drop account check, IRS TIN-match, company-registry
authenticity) return status "unconfigured" unless the relevant key is set — i.e.
"I can't confirm this here", not a green tick.

Each adapter returns: {"status": pass|warn|fail|unconfigured, "severity": ok|low|high,
"message": str}. severity "ok" never changes the decision.
"""
import json
import os
import re
import urllib.request

ENABLED = os.environ.get("ENRICH") == "1"
TIMEOUT = 4

_EU = {"AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
       "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
       "SI", "ES", "SE"}


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "verity/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def _note(status, severity, message):
    return {"status": status, "severity": severity, "message": message}


# 1. EU VAT — VIES (free, no auth). Real existence + registered-name check.
def verify_vat(country, vat):
    cc = (country or "").upper()
    if cc not in _EU:
        return None  # not an EU VAT — nothing to check here
    num = re.sub(r"^[A-Z]{2}", "", re.sub(r"\s+", "", (vat or "").upper()))
    try:
        d = _get_json(f"https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{cc}/vat/{num}")
        if d.get("isValid"):
            nm = (d.get("name") or "").strip()
            return _note("pass", "ok", f"VIES: VAT is live and registered{(' to ' + nm) if nm else ''}")
        return _note("fail", "high", "VIES: not a currently-registered VAT number")
    except Exception:
        return _note("warn", "ok", "VIES unreachable — kept the local format check")


# 2. India IFSC — Razorpay (free, no auth). Real bank/branch resolution.
def verify_ifsc(ifsc):
    code = re.sub(r"\s+", "", (ifsc or "").upper())
    if not re.match(r"^[A-Z]{4}0[A-Z0-9]{6}$", code):
        return _note("fail", "low", f"IFSC '{ifsc}' is malformed (expected AAAA0XXXXXX)")
    try:
        d = _get_json(f"https://ifsc.razorpay.com/{code}")
        return _note("pass", "ok", f"IFSC resolves to {d.get('BANK')} — {d.get('BRANCH')}, {d.get('CITY')}")
    except Exception:
        return _note("warn", "ok", "IFSC directory unreachable — kept the format check")


# 3. Penny-drop bank-account verification — needs a paid payout provider.
def verify_account(account_name, iban_or_acct):
    if not os.environ.get("PENNYDROP_KEY"):
        return _note("unconfigured", "ok",
                     "Account existence not verified — needs a penny-drop provider "
                     "(Razorpay/Cashfree/Plaid). Format/checksum only.")
    return _note("warn", "ok", "Penny-drop provider configured but not implemented in this build")


# 4. Tax-registry validity — IRS TIN-match (US) / GST portal (IN): authenticated.
def verify_tax_registry(country, tax_id):
    if not os.environ.get("TAXREG_KEY"):
        return _note("unconfigured", "ok",
                     f"{country} tax ID not checked against the live registry — needs an "
                     "authenticated API (IRS TIN-match / GST portal). Checksum only.")
    return _note("warn", "ok", "Tax-registry provider configured but not implemented in this build")


# 5. Document authenticity — company-registry lookup (MCA / Companies House): authenticated.
def verify_doc_registry(legal_name, country):
    if not os.environ.get("DOCREG_KEY"):
        return _note("unconfigured", "ok",
                     "Document authenticity not checked against a company registry — needs an "
                     "authenticated API (MCA / Companies House). Text cross-check only.")
    return _note("warn", "ok", "Registry provider configured but not implemented in this build")
