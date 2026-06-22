"""Vendor onboarding decision engine.

Runs a submission through ordered stages. Each check yields a Result with a
severity. The final decision is a deterministic roll-up of those severities so
the outcome is repeatable and explainable — the LLM never decides approve/reject,
it only extracts and drafts (see llm.py).

Severity ladder:
  ok        -> informational, all good
  low       -> fixable by the vendor (missing field, bad format)  -> PENDING
  high      -> needs a human / fraud-ish signal                   -> PENDING (review)
  critical  -> hard stop (blocklist, duplicate bank account)      -> REJECTED
"""
from . import validators as V
from . import enrich

REQUIRED_FIELDS = [
    ("legal_name", "Legal company name"),
    ("country", "Country of registration"),
    ("tax_id", "Tax / VAT registration number"),
    ("bank_name", "Bank name"),
    ("account_name", "Bank account holder name"),
    ("iban", "IBAN / account number"),
    ("contact_email", "Contact email"),
]
REQUIRED_DOCS = ["incorporation_doc", "bank_letter"]

SEVERITY_RANK = {"ok": 0, "low": 1, "high": 2, "critical": 3}


def _r(stage, name, status, severity, message):
    return {"stage": stage, "name": name, "status": status,
            "severity": severity, "message": message}


def run_stages(submission, existing_vendors, blocklist):
    """Generator yielding result dicts stage by stage, then a final summary dict.

    `submission` is the parsed vendor dict (fields + docs).
    `existing_vendors` is a list of known vendor dicts (for duplicate detection).
    `blocklist` is a list of {name, reason} entries.
    """
    results = []

    def emit(res):
        results.append(res)
        return res

    # --- Stage 1: Completeness --------------------------------------------------
    missing_fields = [label for key, label in REQUIRED_FIELDS if not submission.get(key)]
    docs = submission.get("documents", {}) or {}
    missing_docs = [d for d in REQUIRED_DOCS if not docs.get(d)]
    if missing_fields or missing_docs:
        gaps = missing_fields + [f"document: {d}" for d in missing_docs]
        yield emit(_r("Completeness", "Required fields & documents", "fail", "low",
                      "Missing: " + ", ".join(gaps)))
    else:
        yield emit(_r("Completeness", "Required fields & documents", "pass", "ok",
                      "All required fields and documents present"))

    # --- Stage 2: Format validation --------------------------------------------
    ok, msg = V.validate_tax_id(submission.get("country"), submission.get("tax_id"))
    yield emit(_r("Format", "Tax ID format", "pass" if ok else "fail",
                  "ok" if ok else "low", msg))

    ok_email, msg_email = V.validate_email(submission.get("contact_email"))
    yield emit(_r("Format", "Contact email", "pass" if ok_email else "fail",
                  "ok" if ok_email else "low", msg_email))

    iban_ok, iban_msg, iban_cc = V.validate_iban(submission.get("iban"))
    yield emit(_r("Format", "IBAN validity", "pass" if iban_ok else "fail",
                  "ok" if iban_ok else "low", iban_msg))

    # --- Stage 3: Cross-field consistency --------------------------------------
    sim = V.name_similarity(submission.get("legal_name"), submission.get("account_name"))
    if sim >= 0.85:
        yield emit(_r("Consistency", "Legal name vs bank account name", "pass", "ok",
                      f"Names match (similarity {sim:.0%})"))
    elif sim >= 0.6:
        yield emit(_r("Consistency", "Legal name vs bank account name", "warn", "high",
                      f"Partial name match ({sim:.0%}) — review before paying"))
    else:
        yield emit(_r("Consistency", "Legal name vs bank account name", "fail", "high",
                      f"Account holder '{submission.get('account_name')}' does not match "
                      f"vendor '{submission.get('legal_name')}' (similarity {sim:.0%}) — fraud risk"))

    country = (submission.get("country") or "").upper()
    if iban_cc and country and iban_cc != country:
        sev = "high"
        yield emit(_r("Consistency", "IBAN country vs vendor country", "fail", sev,
                      f"IBAN is registered in {iban_cc} but vendor claims {country}"))
    elif iban_cc:
        yield emit(_r("Consistency", "IBAN country vs vendor country", "pass", "ok",
                      f"IBAN country ({iban_cc}) matches vendor country"))

    # --- Stage 4: Document verification ----------------------------------------
    # Each document is either a declared filename (string) or an extracted object
    # {filename, extracted_text, method} produced by the upload/OCR pipeline.
    def _doc_obj(key):
        d = docs.get(key)
        return d if isinstance(d, dict) else None

    bank = _doc_obj("bank_letter")
    if bank and bank.get("extracted_text") is not None:
        method = bank.get("method", "text")
        found = V.find_ibans(bank["extracted_text"])
        sub_norm = V.normalize_iban(submission.get("iban"))
        if sub_norm and sub_norm in found:
            yield emit(_r("Documents", f"Bank letter IBAN ({method})", "pass", "ok",
                          f"Submitted IBAN confirmed on the bank letter via {method}"))
        elif found:
            yield emit(_r("Documents", f"Bank letter IBAN ({method})", "fail", "high",
                          f"Bank letter shows IBAN {found[0]} but the form states "
                          f"{sub_norm or '(none)'} — document contradicts submission"))
        else:
            yield emit(_r("Documents", f"Bank letter IBAN ({method})", "fail", "high",
                          "No IBAN found on the bank letter — wrong document attached?"))
        if not V.text_contains_name(bank["extracted_text"], submission.get("account_name")):
            yield emit(_r("Documents", "Bank letter account name", "warn", "high",
                          f"Account holder '{submission.get('account_name')}' not found in the bank letter"))
    elif docs.get("bank_letter"):
        yield emit(_r("Documents", "Bank letter", "pass", "ok",
                      "Declared (no file uploaded — not extracted)"))

    inc = _doc_obj("incorporation_doc")
    if inc and inc.get("extracted_text") is not None:
        method = inc.get("method", "text")
        if V.text_contains_name(inc["extracted_text"], submission.get("legal_name")):
            yield emit(_r("Documents", f"Incorporation doc ({method})", "pass", "ok",
                          f"Vendor name confirmed on incorporation document via {method}"))
        else:
            yield emit(_r("Documents", f"Incorporation doc ({method})", "fail", "high",
                          f"'{submission.get('legal_name')}' not found in incorporation document "
                          "— wrong document attached?"))
    elif docs.get("incorporation_doc"):
        yield emit(_r("Documents", "Incorporation document", "pass", "ok",
                      "Declared (no file uploaded — not extracted)"))

    # --- Stage 5: Risk / credibility -------------------------------------------
    sub_iban = V.normalize_iban(submission.get("iban"))
    dup = None
    for ev in existing_vendors:
        if sub_iban and V.normalize_iban(ev.get("iban")) == sub_iban \
                and V.name_similarity(ev.get("legal_name"), submission.get("legal_name")) < 0.85:
            dup = ev
            break
    if dup:
        yield emit(_r("Risk", "Duplicate bank account", "fail", "critical",
                      f"IBAN already on file for existing vendor '{dup.get('legal_name')}' "
                      f"(id {dup.get('id')}) — possible payment-redirection fraud"))
    else:
        yield emit(_r("Risk", "Duplicate bank account", "pass", "ok",
                      "IBAN not linked to any other vendor"))

    hit = V.sanctions_match(submission.get("legal_name"), blocklist)
    if hit:
        yield emit(_r("Risk", "Sanctions / blocklist", "fail", "critical",
                      f"Matches blocklist entry '{hit.get('name')}' via {hit.get('method')}: "
                      f"{hit.get('reason')}"))
    else:
        yield emit(_r("Risk", "Sanctions / blocklist", "pass", "ok",
                      "No blocklist match (fuzzy + phonetic screen)"))

    # --- Stage 6: External verification (opt-in via ENRICH=1) -------------------
    # Real for free public services (VIES VAT, IFSC); honest "unconfigured" for the
    # ones that need a paid/authenticated provider. Off by default so the offline
    # demo is untouched.
    if enrich.ENABLED:
        country = (submission.get("country") or "").upper()
        vat = enrich.verify_vat(country, submission.get("tax_id"))
        if vat:
            yield emit(_r("Verify", "Live VAT (VIES)", vat["status"], vat["severity"], vat["message"]))
        else:
            reg = enrich.verify_tax_registry(country, submission.get("tax_id"))
            yield emit(_r("Verify", "Tax registry", reg["status"], reg["severity"], reg["message"]))
        acct = enrich.verify_account(submission.get("account_name"), submission.get("iban"))
        yield emit(_r("Verify", "Bank account (penny-drop)", acct["status"], acct["severity"], acct["message"]))
        doc = enrich.verify_doc_registry(submission.get("legal_name"), country)
        yield emit(_r("Verify", "Document registry", doc["status"], doc["severity"], doc["message"]))

    # --- Decision roll-up -------------------------------------------------------
    worst = max((SEVERITY_RANK[r["severity"]] for r in results), default=0)
    fails = [r for r in results if r["status"] in ("fail", "warn")]
    if worst >= SEVERITY_RANK["critical"]:
        decision = "REJECTED"
        headline = "Hard stop — critical risk signal. Do not onboard."
    elif worst >= SEVERITY_RANK["high"]:
        decision = "PENDING"
        headline = "Needs manual review — consistency/risk flags before approval."
    elif worst >= SEVERITY_RANK["low"]:
        decision = "PENDING"
        headline = "Incomplete or malformed — vendor action required."
    else:
        decision = "APPROVED"
        headline = "All checks passed — cleared for payment setup."

    yield {
        "final": True,
        "decision": decision,
        "headline": headline,
        "results": results,
        "issues": fails,
    }
