"""PDF text extraction — PyMuPDF text layer.

Scope decision (deliberate): we extract the *text layer* of uploaded PDFs and
cross-reference it against the submitted form. That alone delivers the one thing
form-field validation cannot — catching a document whose contents contradict the
submission (e.g. a bank letter showing a different IBAN). Scanned-image OCR
(RapidOCR) and Claude-vision were dropped: they only add the ability to read
image-only PDFs, which isn't needed to demonstrate the core "wrong document"
check, and they were the heaviest dependencies / most code paths to explain.

Returns: {"text": str, "method": "text"|"empty", "chars": int, "pages": int}
"""
import fitz  # PyMuPDF


def extract_pdf(data: bytes, mode: str = "auto"):
    """Extract the text layer from raw PDF bytes. `mode` kept for API compat."""
    doc = fitz.open(stream=data, filetype="pdf")
    pages = doc.page_count
    text = "\n".join(t for t in (p.get_text().strip() for p in doc) if t).strip()
    doc.close()
    if text:
        return {"text": text, "method": "text", "chars": len(text), "pages": pages}
    # Image-only PDF: no text layer. We don't OCR — say so honestly rather than guess.
    return {"text": "", "method": "empty", "chars": 0, "pages": pages,
            "err": "no text layer (scanned image — OCR not enabled)"}
