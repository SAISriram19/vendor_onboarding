"""FastAPI server: live-run SSE endpoint + history dashboard API + static UI."""
import json
import os
import time

from typing import Optional

from fastapi import FastAPI, Request, Form, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse

from . import engine, llm, store, extract, validators as V

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_dotenv():
    """Load KEY=VALUE lines from a project-root .env into the environment.
    ponytail: 6 lines of stdlib beats pulling in python-dotenv for this."""
    path = os.path.join(_BASE, ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()
app = FastAPI(title="Vendor Onboarding")

# Allowed origins: localhost for dev, plus any set in FRONTEND_ORIGIN (comma-sep)
# for the deployed Vercel domain. "*" is accepted as a catch-all for the demo.
_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
_extra = os.environ.get("FRONTEND_ORIGIN", "")
if _extra:
    _origins += [o.strip() for o in _extra.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if "*" in _origins else _origins,
    allow_methods=["*"], allow_headers=["*"],
)

# Timestamps are injected by the caller (the test harness / clock) so the engine
# stays pure. The server stamps wall-clock time here at the edge.
from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


@app.get("/api/status")
def status():
    return {"ai": bool(os.environ.get("ANTHROPIC_API_KEY"))}


@app.get("/api/samples")
def samples():
    out = []
    sdir = os.path.join(_BASE, "samples")
    for fn in sorted(os.listdir(sdir)):
        if fn.endswith(".json"):
            with open(os.path.join(sdir, fn), encoding="utf-8") as f:
                data = json.load(f)
            out.append({"file": fn, "label": data.get("_label", fn), "data": data})
    return out


@app.get("/api/vendors")
def vendors():
    return store.load_json("existing_vendors.json", [])


@app.get("/api/blocklist")
def blocklist():
    return store.load_json("blocklist.json", [])


@app.get("/api/runs")
def runs():
    return [{k: r[k] for k in ("id", "ts", "vendor", "decision", "headline")} for r in store.all_runs()]


@app.get("/api/run/{run_id}")
def run_detail(run_id: str):
    for r in store.all_runs():
        if r["id"] == run_id:
            return r
    return JSONResponse({"error": "not found"}, status_code=404)


@app.post("/api/extract")
async def extract_doc(
    kind: str = Form("bank_letter"),
    iban: str = Form(""),
    account_name: str = Form(""),
    legal_name: str = Form(""),
    file: UploadFile = File(...),
):
    """Background document scan: extract a single uploaded PDF and cross-reference
    it against the in-progress form values. Powers the live 'scanning…' feedback
    before the full review is run."""
    data = await file.read()
    try:
        ex = extract.extract_pdf(data)
    except Exception as e:
        return JSONResponse({"ok": False, "method": "error", "message": str(e)}, status_code=200)

    text = ex.get("text", "")
    out = {"ok": ex["chars"] > 0, "method": ex["method"], "chars": ex["chars"],
           "pages": ex["pages"], "filename": file.filename, "checks": []}
    if ex["chars"] == 0:
        out["message"] = ex.get("err", "no text extracted")
        return out

    if kind == "bank_letter":
        found = V.find_ibans(text)
        sub = V.normalize_iban(iban)
        if sub and sub in found:
            out["checks"].append({"label": "IBAN on letter", "status": "pass",
                                  "message": "Submitted IBAN confirmed on the bank letter"})
        elif found:
            out["checks"].append({"label": "IBAN on letter", "status": "fail",
                                  "message": f"Letter shows {found[0]} — contradicts the form ({sub or 'none'})"})
        else:
            out["checks"].append({"label": "IBAN on letter", "status": "fail",
                                  "message": "No IBAN found — wrong document attached?"})
        if account_name and not V.text_contains_name(text, account_name):
            out["checks"].append({"label": "Account name", "status": "warn",
                                  "message": f"'{account_name}' not found on the letter"})
    else:  # incorporation_doc
        if legal_name and V.text_contains_name(text, legal_name):
            out["checks"].append({"label": "Company name", "status": "pass",
                                  "message": "Vendor name confirmed on the incorporation document"})
        else:
            out["checks"].append({"label": "Company name", "status": "fail",
                                  "message": f"'{legal_name}' not found — wrong document attached?"})
    return out


@app.post("/api/run")
async def run_submission(
    submission: str = Form(...),
    extractor: str = Form("auto"),
    incorporation_doc: Optional[UploadFile] = File(None),
    bank_letter: Optional[UploadFile] = File(None),
):
    submission = json.loads(submission)
    submission.pop("_label", None)
    submission.setdefault("documents", {})
    existing = store.load_json("existing_vendors.json", [])
    blocklist = store.load_json("blocklist.json", [])

    # Read uploaded files now (async) — extraction itself runs in the stream below.
    uploads = []
    for key, up in (("incorporation_doc", incorporation_doc), ("bank_letter", bank_letter)):
        if up is not None and up.filename:
            uploads.append((key, up.filename, await up.read()))

    def gen():
        # Stage 0: extract text/OCR from each uploaded PDF, feed into the submission.
        for key, fname, data in uploads:
            try:
                ex = extract.extract_pdf(data, mode=extractor)
            except Exception as e:
                ex = {"text": "", "method": "error", "chars": 0, "pages": 0, "err": str(e)}
            submission["documents"][key] = {
                "filename": fname, "extracted_text": ex["text"], "method": ex["method"]}
            if ex["chars"] > 0:
                res = {"stage": "Intake", "name": f"PDF extraction · {key}", "status": "pass",
                       "severity": "ok",
                       "message": f"Extracted {ex['chars']} chars from {fname} via "
                                  f"{ex['method'].upper()} ({ex['pages']} page(s))"}
            else:
                res = {"stage": "Intake", "name": f"PDF extraction · {key}", "status": "fail",
                       "severity": "high",
                       "message": f"Could not extract text from {fname} ({ex.get('err','no text/OCR result')})"}
            yield f"event: stage\ndata: {json.dumps(res)}\n\n"
            time.sleep(0.3)

        final = None
        for item in engine.run_stages(submission, existing, blocklist):
            if item.get("final"):
                final = item
                break
            yield f"event: stage\ndata: {json.dumps(item)}\n\n"
            time.sleep(0.45)  # visible step-by-step pacing for the live view

        drafts = llm.draft_outputs(submission, final["decision"], final["issues"])
        run = {
            "id": store.next_run_id(),
            "ts": _now(),
            "vendor": submission.get("legal_name") or "(unnamed)",
            "decision": final["decision"],
            "headline": final["headline"],
            "submission": submission,
            "results": final["results"],
            "issues": final["issues"],
            "email": drafts["email"],
            "summary": drafts["summary"],
            "ai_used": drafts["ai_used"],
        }
        store.save_run(run)
        yield f"event: final\ndata: {json.dumps(run)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/")
def index():
    return {"service": "verity-api", "note": "API only — the UI runs from web/"}
