"""AI layer (the 'hybrid' half).

Deterministic rules in engine.py decide approve/reject. The LLM does the two
jobs it's actually good at:
  1. Drafting the vendor-facing follow-up email for anything not approved.
  2. A one-line plain-language summary for the non-technical AP reviewer.

If ANTHROPIC_API_KEY is set we call Claude; otherwise we fall back to a
deterministic template so the process always runs live.
"""
import os

MODEL = "claude-opus-4-8"


def _client():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        import anthropic
        return anthropic.Anthropic(api_key=key)
    except Exception:
        return None


def _fallback_email(submission, decision, issues):
    name = submission.get("legal_name") or "there"
    if decision == "APPROVED":
        return (f"Hi {name},\n\nGood news — your vendor onboarding has been approved "
                f"and you're set up for payment. No further action needed.\n\nThanks.")
    lines = []
    for i in issues:
        lines.append(f"  - {i['name']}: {i['message']}")
    body = "\n".join(lines) if lines else "  - (see attached detail)"
    verb = "could not be completed" if decision == "REJECTED" else "needs a few corrections"
    return (f"Hi {name},\n\nThanks for your submission. Your onboarding {verb}. "
            f"Please review the items below:\n\n{body}\n\n"
            f"Reply with the corrected information or documents and we'll continue the review.\n\nThanks.")


def _fallback_summary(decision, issues):
    if decision == "APPROVED":
        return "Vendor cleared all checks; safe to set up for payment."
    n = len(issues)
    return f"{decision.title()}: {n} issue(s) found — {', '.join(i['name'] for i in issues[:3])}."


def draft_outputs(submission, decision, issues):
    """Return {'email': str, 'summary': str, 'ai_used': bool}."""
    client = _client()
    if client is None:
        return {"email": _fallback_email(submission, decision, issues),
                "summary": _fallback_summary(decision, issues),
                "ai_used": False}
    issue_text = "\n".join(f"- {i['name']}: {i['message']}" for i in issues) or "(none)"
    prompt = (
        "You are an accounts-payable assistant. A vendor onboarding submission was "
        f"reviewed by a rules engine. Decision: {decision}.\n"
        f"Vendor: {submission.get('legal_name')}\n"
        f"Issues found:\n{issue_text}\n\n"
        "Write TWO things, separated by a line containing only '---':\n"
        "1) A short, polite, specific email to the vendor explaining the decision and "
        "exactly what they must fix or provide (omit if APPROVED, just confirm).\n"
        "2) A single-sentence summary for the internal AP reviewer.\n"
        "Be concrete. Do not invent issues beyond those listed."
    )
    try:
        msg = client.messages.create(
            model=MODEL, max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text
        parts = text.split("---", 1)
        email = parts[0].strip()
        summary = parts[1].strip() if len(parts) > 1 else _fallback_summary(decision, issues)
        return {"email": email, "summary": summary, "ai_used": True}
    except Exception as e:
        out = {"email": _fallback_email(submission, decision, issues),
               "summary": _fallback_summary(decision, issues), "ai_used": False}
        out["summary"] += f" (AI draft unavailable: {e})"
        return out
