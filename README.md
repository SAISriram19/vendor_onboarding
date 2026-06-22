# Vendor Onboarding — AP Review & Risk Decisioning (Zamp ASA · PS-2)

Takes a vendor submission (JSON + listed documents) → runs it through a staged
review engine → produces **APPROVED / PENDING / REJECTED** with a full reasoning
trace, a reviewer summary, and an auto-drafted vendor follow-up email.

## Design in one line
**Deterministic rules decide; AI drafts.** The decision is a repeatable roll-up
of per-check severities (explainable, testable). Claude is used only for the
vendor follow-up email + plain-language summary — and falls back to templates if
no API key is set, so the process always runs live.

## Pipeline stages
0. **Intake / extraction** — uploaded PDFs are transcribed by one of three back-ends
   (pick per-run in the UI; `method` shown live in the Intake stage):
   - **Claude vision** (`claude-opus-4-8`, base64 `document` block) — used by default when
     `ANTHROPIC_API_KEY` is set. Reads scanned + text PDFs in one shot, its own OCR.
   - **PyMuPDF** text layer — machine-readable PDFs, instant.
   - **RapidOCR** (ONNX) — scanned image-only PDFs; no Tesseract/poppler needed.
   `auto` = Claude if key set else local; `claude` falls back to local on error;
   `local` forces PyMuPDF/RapidOCR.
1. **Completeness** — required fields + documents present?
2. **Format** — tax-ID format per country, IBAN structure + mod-97 checksum, email.
3. **Consistency** — legal name vs bank account name (fuzzy), IBAN country vs vendor country.
4. **Documents** — cross-check extracted bank-letter IBAN + account name and the
   incorporation doc's vendor name against the submitted form (catches wrong/contradicting docs).
5. **Risk** — duplicate bank account vs existing vendors, sanctions/blocklist match.
6. **Decision roll-up** — worst severity → outcome.

## Document upload + OCR
Upload a real **incorporation PDF** and **bank letter PDF** in the UI. The Documents
stage verifies the IBAN printed on the bank letter matches the form, and the vendor
name appears on the incorporation doc. Sample PDFs live in `samples/docs/`
(regenerate with `python samples/make_docs.py`):
- `helvetia_bank.pdf` — text-layer, IBAN matches happy path → confirms.
- `helvetia_bank_scanned.pdf` — image-only → forces the **OCR** path → confirms.
- `wrong_bank.pdf` — different IBAN → **contradiction**, drops decision to PENDING.
- `helvetia_incorp.pdf` — incorporation certificate.

Severity → outcome: `critical` → REJECTED · `high`/`low` → PENDING · all `ok` → APPROVED.

## Edge cases (in `samples/`)
| File | Scenario | Expected |
|------|----------|----------|
| 01_happy_path | clean German vendor | APPROVED |
| 02_name_mismatch | account holder ≠ vendor (fraud) | PENDING (review) |
| 03_taxid_country_mismatch | US EIN claimed as German VAT | PENDING |
| 04_incomplete | missing IBAN + bank letter | PENDING (vendor action) |
| 05_duplicate_bank | new vendor reuses existing IBAN | REJECTED (critical) |
| 06_blocklist | sanctions/blocklist hit | REJECTED (critical) |

## Run it
```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8077
# open http://localhost:8077
```
Optional AI drafting:
```bash
export ANTHROPIC_API_KEY=sk-ant-...   # Windows: set ANTHROPIC_API_KEY=...
```

## UI
- **Left:** pick a sample (or edit the JSON), run.
- **Center:** live run view — each stage streams in (SSE) with severity colour.
- Decision banner + reviewer summary + vendor email.
- **Bottom-left:** run-history dashboard; click any row to replay its trace.

## Layout
```
app/validators.py  pure checks (tax-id, IBAN mod-97, name fuzzy, IBAN-in-text)
app/extract.py     PDF extraction: Claude vision + PyMuPDF + RapidOCR (mode-selectable)
app/engine.py      staged pipeline + decision roll-up
app/llm.py         AI email/summary (with template fallback)
app/store.py       JSON run-history persistence
app/main.py        FastAPI: multipart SSE run + dashboard API + static UI
data/              existing_vendors.json, blocklist.json, runs.json
samples/           happy path + 5 edge cases
samples/docs/      generated PDFs (text, scanned/OCR, contradicting) + make_docs.py
static/index.html  single-file UI (sample picker, file upload, live run, dashboard)
```
