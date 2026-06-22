import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Vera } from "@/components/Vera";
import * as api from "@/lib/api";
import type { RunResult, Stage, SampleEntry } from "@/lib/api";
import type { Submission } from "@/lib/validators";
import {
  deriveLive, type Docs, type RefData, C, fieldColor, fieldBg, fieldBorder, VERDICT_TONE,
} from "@/lib/verity";

const EMPTY: Submission = {
  legal_name: "", country: "", tax_id: "", bank_name: "", account_name: "", iban: "", contact_email: "",
};
type DocKey = "bank_letter" | "incorporation_doc";
const EMPTY_DOCS: Docs = {
  bank_letter: { file: null, scanning: false, result: null },
  incorporation_doc: { file: null, scanning: false, result: null },
};

const FIELD_DEFS: { key: keyof Submission; label: string; placeholder: string; mono: boolean; span: boolean }[] = [
  { key: "legal_name", label: "Legal company name", placeholder: "Acme Industries GmbH", mono: false, span: true },
  { key: "country", label: "Country (DE · US · GB · FR · IN · AU · NL)", placeholder: "DE", mono: true, span: false },
  { key: "tax_id", label: "Tax / VAT ID", placeholder: "DE123456789", mono: true, span: false },
  { key: "bank_name", label: "Bank name", placeholder: "Deutsche Bank", mono: false, span: false },
  { key: "account_name", label: "Bank account holder", placeholder: "Acme Industries GmbH", mono: false, span: false },
  { key: "iban", label: "IBAN", placeholder: "DE89 3704 0044 0532 0130 00", mono: true, span: true },
  { key: "contact_email", label: "Contact email", placeholder: "ap@vendor.com", mono: false, span: false },
];

const SEV_BG: Record<string, string> = { ok: C.okBg, low: C.warnBg, high: C.warnBg, critical: C.badBg };
const traceColor = (status: string) => (status === "pass" ? C.ok : status === "fail" ? C.bad : C.warn);
const traceGlyph = (status: string) => (status === "pass" ? "✓" : status === "fail" ? "✕" : "!");
const DEC_TONE: Record<string, { color: string; bg: string; border: string; glyph: string }> = {
  APPROVED: { color: C.ok, bg: C.okBg, border: C.okBorder, glyph: "✓" },
  PENDING: { color: C.warn, bg: C.warnBg, border: C.warnBorder, glyph: "!" },
  REJECTED: { color: C.bad, bg: C.badBg, border: C.badBorder, glyph: "✕" },
};

function sampleTag(file: string): { tag: string; color: string } {
  const n = file.slice(0, 2);
  return ({
    "01": { tag: "Clean vendor", color: C.ok },
    "02": { tag: "Fraud signal", color: C.bad },
    "03": { tag: "Format conflict", color: C.warn },
    "04": { tag: "Vendor action", color: "#8C8794" },
    "05": { tag: "Hard stop", color: C.bad },
    "06": { tag: "Hard stop", color: C.bad },
  } as Record<string, { tag: string; color: string }>)[n] ?? { tag: "Sample", color: "#8C8794" };
}

const UI = {
  caps: { fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#8C8794" } as CSSProperties,
  card: { background: "#fff", border: "1px solid #E8E4DA", borderRadius: 14 } as CSSProperties,
};

export default function App() {
  const [view, setView] = useState<"review" | "history">("review");
  const [ai, setAi] = useState(false);
  const [sub, setSub] = useState<Submission>(EMPTY);
  const [preset, setPreset] = useState<string | null>(null);
  const [docs, setDocs] = useState<Docs>(EMPTY_DOCS);
  const [running, setRunning] = useState(false);
  const [streamed, setStreamed] = useState<Stage[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runs, setRuns] = useState<Pick<RunResult, "id" | "ts" | "vendor" | "decision" | "headline">[]>([]);
  const [samples, setSamples] = useState<SampleEntry[]>([]);
  const [ref, setRef] = useState<RefData>({ vendors: [], blocklist: [] });
  const [touched, setTouched] = useState<Set<keyof Submission>>(new Set());
  const ALL_KEYS = Object.keys(EMPTY) as (keyof Submission)[];

  useEffect(() => {
    api.getStatus().then((s) => setAi(s.ai)).catch(() => {});
    api.getSamples().then(setSamples).catch(() => {});
    api.getRuns().then(setRuns).catch(() => {});
    Promise.all([api.getVendors().catch(() => []), api.getBlocklist().catch(() => [])])
      .then(([vendors, blocklist]) => setRef({ vendors, blocklist }));
  }, []);

  const live = useMemo(() => deriveLive(sub, docs, ref, touched), [sub, docs, ref, touched]);

  // debounce Vera's spoken line / mood so fast typing doesn't restart it
  const [mood, setMood] = useState(live.mood);
  const [says, setSays] = useState(live.says);
  const [moodLabel, setMoodLabel] = useState(live.moodLabel);
  const tmr = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(tmr.current);
    tmr.current = window.setTimeout(() => {
      setMood(live.mood); setSays(live.says); setMoodLabel(live.moodLabel);
    }, 300);
    return () => window.clearTimeout(tmr.current);
  }, [live.mood, live.says, live.moodLabel]);

  // Editing the form invalidates any shown result/trace — clear it so the trace
  // never lingers next to inputs it no longer describes. Re-run to get a fresh one.
  const clearResult = () => { setResult(null); setStreamed([]); };

  const setField = (k: keyof Submission, v: string) => {
    setSub((s) => ({ ...s, [k]: k === "country" ? v.toUpperCase() : v }));
    if (result || streamed.length) clearResult();
  };

  function loadSample(e: SampleEntry) {
    const d = e.data as Submission;
    setSub({
      legal_name: d.legal_name ?? "", country: d.country ?? "", tax_id: d.tax_id ?? "",
      bank_name: d.bank_name ?? "", account_name: d.account_name ?? "", iban: d.iban ?? "",
      contact_email: d.contact_email ?? "",
    });
    setPreset(e.file); setDocs(EMPTY_DOCS); setResult(null); setStreamed([]); setRunning(false);
    setTouched(new Set(ALL_KEYS)); // a loaded sample evaluates immediately
  }

  async function pickDoc(kind: DocKey, f: File | null) {
    if (result || streamed.length) clearResult();
    setDocs((s) => ({ ...s, [kind]: { file: f, scanning: !!f, result: null } }));
    if (!f) return;
    try {
      const res = await api.scanDoc(kind, f, sub);
      setDocs((s) => ({ ...s, [kind]: { file: f, scanning: false, result: res } }));
    } catch {
      setDocs((s) => ({ ...s, [kind]: { file: f, scanning: false, result: null } }));
    }
  }

  const canRun = (Object.keys(EMPTY) as (keyof Submission)[]).every((k) => sub[k]) && !running;

  async function doRun() {
    if (!canRun) return;
    setRunning(true); setResult(null); setStreamed([]);
    try {
      const final = await api.runReview(
        sub,
        { bank_letter: docs.bank_letter.file ?? undefined, incorporation_doc: docs.incorporation_doc.file ?? undefined },
        (st) => setStreamed((p) => [...p, st]),
      );
      setResult(final);
      api.getRuns().then(setRuns);
    } catch (e) {
      setStreamed((p) => [...p, { stage: "Error", name: "Run failed", status: "fail", severity: "critical", message: String(e) }]);
    } finally {
      setRunning(false);
    }
  }

  async function replay(id: string) {
    const r = await api.getRun(id);
    const d = r.submission;
    if (d) {
      setSub({
        legal_name: d.legal_name ?? "", country: d.country ?? "", tax_id: d.tax_id ?? "",
        bank_name: d.bank_name ?? "", account_name: d.account_name ?? "", iban: d.iban ?? "",
        contact_email: d.contact_email ?? "",
      });
      setTouched(new Set(ALL_KEYS)); // show field states matching the replayed run
    }
    setDocs(EMPTY_DOCS); setPreset(null);
    setResult(r); setStreamed(r.results); setRunning(false); setView("review");
  }

  const vt = VERDICT_TONE[live.verdict];
  const traceRows = running ? streamed : result ? result.results : [];

  return (
    <div style={{ minHeight: "100vh", width: "100%", display: "flex", flexDirection: "column", background: "#E9E7EC", color: "#1E1B26" }}>
      {/* TOP BAR */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 28px", background: "#1E1B26", color: "#F4F4F1", position: "sticky", top: 0, zIndex: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: "linear-gradient(150deg, #8A6FE6, #6B4FC9)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 12px rgba(107,79,201,.5)" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#F4F4F1" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2.5 4 5.5v6c0 5 3.5 8.2 8 10 4.5-1.8 8-5 8-10v-6L12 2.5Z" /><path d="m8.6 11.8 2.4 2.4 4.4-4.6" /></svg>
          </div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.05 }}>
            <span style={{ fontFamily: "'Bricolage Grotesque', system-ui, sans-serif", fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>Verity</span>
            <span style={{ fontSize: 11, color: "#989AA2", fontWeight: 500 }}>Vendor onboarding &amp; AP risk review</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderRadius: 999, background: ai ? "rgba(107,79,201,.20)" : "rgba(155,157,166,.18)", border: `1px solid ${ai ? "rgba(107,79,201,.5)" : "rgba(155,157,166,.4)"}` }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: ai ? "#A48CF0" : "#9B9DA6" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "#E8E8EC", whiteSpace: "nowrap" }}>{ai ? "AI drafting on" : "Template fallback"}</span>
          </div>
          <div style={{ display: "flex", background: "#2A2633", borderRadius: 999, padding: 3 }}>
            {(["review", "history"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} style={{ border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, padding: "6px 14px", borderRadius: 999, color: view === v ? "#1E1B26" : "#9B9DA6", background: view === v ? "#FAF9FC" : "transparent" }}>
                {v === "review" ? "Review" : "History"}
              </button>
            ))}
          </div>
        </div>
      </header>

      {view === "review" ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 396px", flex: 1, alignItems: "stretch" }}>
          {/* LEFT: FORM */}
          <section style={{ padding: "32px 40px", borderRight: "1px solid #E4E1EA", background: "#FAF9FC", display: "flex", flexDirection: "column", gap: 22, maxHeight: "calc(100vh - 63px)", overflowY: "auto" }}>
            <div>
              <div style={{ ...UI.caps, marginBottom: 11 }}>Load a sample submission</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {samples.map((s) => {
                  const t = sampleTag(s.file);
                  const sel = preset === s.file;
                  return (
                    <button key={s.file} onClick={() => loadSample(s)} title={s.label}
                      style={{ textAlign: "left", cursor: "pointer", border: `1px solid ${sel ? "#1E1B26" : "#E1DDD2"}`, background: sel ? "#FFFFFF" : "#FBFAFD", color: "#2A2C33", borderRadius: 11, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label.split("—")[0].trim()}</span>
                      <span style={{ fontSize: 11, color: t.color, fontWeight: 600 }}>{t.tag}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ height: 1, background: "#E8E5EF" }} />

            {/* FIELDS */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px 20px" }}>
              {FIELD_DEFS.map((d) => {
                const fs = live.fields[d.key];
                return (
                  <div key={d.key} style={{ gridColumn: d.span ? "span 2" : "auto" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <label style={{ fontSize: 12.5, fontWeight: 600, color: "#43404A" }}>{d.label}</label>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: fieldColor(fs.status) }}>{fs.status === "ok" || fs.status === "idle" ? "" : fs.message}</span>
                    </div>
                    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                      <input value={sub[d.key]} onChange={(e) => setField(d.key, e.target.value)}
                        onBlur={() => setTouched((t) => new Set(t).add(d.key))} placeholder={d.placeholder}
                        style={{ width: "100%", fontFamily: d.mono ? "'JetBrains Mono', monospace" : "inherit", fontSize: 15, fontWeight: 500, color: "#1B1D22", padding: "13px 38px 13px 15px", borderRadius: 11, border: `1.5px solid ${fieldBorder(fs.status)}`, background: fieldBg(fs.status) }} />
                      <span style={{ position: "absolute", right: 13, width: 9, height: 9, borderRadius: "50%", background: fieldColor(fs.status) }} />
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ height: 1, background: "#E8E5EF" }} />

            {/* DOC ZONES */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={UI.caps}>Supporting documents</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
                {([
                  { kind: "bank_letter" as DocKey, title: "Bank confirmation letter", isBank: true },
                  { kind: "incorporation_doc" as DocKey, title: "Incorporation document", isBank: false },
                ]).map((z) => {
                  const d = docs[z.kind];
                  const checks = d.result?.checks ?? [];
                  const anyFail = checks.some((c) => c.status === "fail");
                  const scanned = !!d.result;
                  const statusText = d.scanning ? "Scanning in the background…"
                    : scanned ? `Extracted via ${d.result!.method} · ${d.result!.filename}`
                    : "Click or drop a PDF";
                  const statusColor = d.scanning ? C.purple : scanned ? (anyFail ? C.bad : C.ok) : "#94909E";
                  const glyphColor = scanned ? (anyFail ? C.bad : C.ok) : d.scanning ? C.purple : "#6E6A78";
                  const border = scanned ? (anyFail ? C.badBorder : C.okBorder) : d.scanning ? "#CFC2F2" : "#E0DCE8";
                  const bg = scanned ? (anyFail ? "#FFF7F6" : "#F7FCF9") : d.scanning ? "#EFEBFA" : "#FBFAFD";
                  const iconBg = scanned ? (anyFail ? C.badBg : C.okBg) : "#F0EEF6";
                  return (
                    <label key={z.kind} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) pickDoc(z.kind, f); }} onDragOver={(e) => e.preventDefault()}
                      style={{ display: "block", cursor: "pointer", border: `1.5px dashed ${border}`, background: bg, borderRadius: 12, padding: "12px 13px" }}>
                      <input type="file" accept="application/pdf" onChange={(e) => pickDoc(z.kind, e.target.files?.[0] ?? null)} style={{ display: "none" }} />
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 9, background: iconBg, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", position: "relative", overflow: "hidden" }}>
                          {z.isBank ? (
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={glyphColor} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9.5 12 4l9 5.5" /><path d="M4 10v8M9 10v8M15 10v8M20 10v8" /><path d="M2.5 21h19" /></svg>
                          ) : (
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={glyphColor} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></svg>
                          )}
                          {d.scanning && <span style={{ position: "absolute", left: 0, right: 0, height: 2, background: C.purple, boxShadow: `0 0 8px ${C.purple}`, animation: "vr-scan 1s linear infinite" }} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: "#2A2C33" }}>{z.title}</div>
                          <div style={{ fontSize: 11, fontWeight: 500, color: statusColor }}>{statusText}</div>
                        </div>
                      </div>
                      {checks.length > 0 && (
                        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, paddingTop: 10, borderTop: "1px solid rgba(0,0,0,.07)" }}>
                          {checks.map((c, i) => (
                            <div key={i} className="vr-row" style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                              <span style={{ width: 14, height: 14, borderRadius: "50%", background: traceColor(c.status), color: "#fff", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", marginTop: 1 }}>{traceGlyph(c.status)}</span>
                              <span style={{ fontSize: 11.5, fontWeight: 500, color: "#3A3D44", lineHeight: 1.35 }}>{c.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>

            <button onClick={doRun} disabled={!canRun}
              style={{ marginTop: 4, width: "100%", cursor: canRun ? "pointer" : "not-allowed", fontSize: 14, fontWeight: 700, padding: 14, borderRadius: 11, border: "none", color: canRun ? "#FAF9FC" : "#A6A29A", background: canRun ? "#1E1B26" : "#E1DDD2", boxShadow: canRun ? "0 6px 18px rgba(22,24,29,.28)" : "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
              {running && <span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,.4)", borderTopColor: "#fff", borderRadius: "50%", animation: "vr-think .7s linear infinite" }} />}
              {running ? "Running review…" : canRun ? "Run full review" : "Complete all fields to run"}
            </button>
          </section>

          {/* RIGHT: REVIEWER + RESULTS */}
          <section style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20, maxHeight: "calc(100vh - 63px)", overflowY: "auto" }}>
            <Vera mood={mood} label={moodLabel} says={says} />

            {/* LIVE VERDICT */}
            <div style={{ flex: 1, maxHeight: 88, background: vt.bg, border: `1px solid ${vt.border}`, borderRadius: 16, padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ ...UI.caps, marginBottom: 6 }}>Live verdict</div>
                <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: vt.color }}>{live.verdict}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#6B6F76", marginBottom: 6 }}>{live.pass} / {live.total} checks pass</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {Array.from({ length: live.total }).map((_, i) => (
                    <span key={i} style={{ width: 26, height: 6, borderRadius: 3, background: i < live.pass ? vt.color : "#E1DDD2" }} />
                  ))}
                </div>
              </div>
            </div>

            {(running || result) ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                {result && (
                  <div style={{ background: DEC_TONE[result.decision].bg, border: `1px solid ${DEC_TONE[result.decision].border}`, borderRadius: 16, padding: "18px 20px", display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ width: 46, height: 46, borderRadius: 13, background: DEC_TONE[result.decision].color, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", fontSize: 22, color: "#fff" }}>{DEC_TONE[result.decision].glyph}</div>
                    <div>
                      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", color: DEC_TONE[result.decision].color, lineHeight: 1.1 }}>{result.decision}</div>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: "#3A3D44", marginTop: 3 }}>{result.headline}</div>
                    </div>
                  </div>
                )}

                <div>
                  <div style={{ ...UI.caps, marginBottom: 10 }}>Review trace</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {traceRows.map((t, i) => (
                      <div key={`${t.stage}-${t.name}-${i}`} className="vr-row" style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", border: "1px solid #E8E4DA", borderLeft: `3px solid ${traceColor(t.status)}`, borderRadius: 10, padding: "11px 14px" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#9A95A4", width: 88, flex: "none" }}>{t.stage}</span>
                        <span style={{ width: 18, height: 18, borderRadius: "50%", background: traceColor(t.status), color: "#fff", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{traceGlyph(t.status)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#20232A" }}>{t.name}</div>
                          <div style={{ fontSize: 12, fontWeight: 500, color: "#5C6066" }}>{t.message}</div>
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: traceColor(t.status), background: SEV_BG[t.severity] ?? "#F4F2EC", padding: "3px 8px", borderRadius: 999, flex: "none" }}>{t.severity}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {result && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
                    <div style={{ ...UI.card, padding: "16px 18px" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <span style={UI.caps}>Reviewer summary</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: result.ai_used ? C.purple : "#8C8794", background: result.ai_used ? "rgba(107,79,201,.12)" : "#F0EEE7", padding: "3px 8px", borderRadius: 999 }}>{result.ai_used ? "AI-drafted" : "Template"}</span>
                      </div>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: "#2A2C33", lineHeight: 1.5 }}>{result.summary}</div>
                    </div>
                    <div style={{ ...UI.card, padding: "16px 18px" }}>
                      <div style={{ ...UI.caps, marginBottom: 8 }}>Vendor follow-up email</div>
                      <div style={{ fontSize: 12.5, fontWeight: 500, color: "#2A2C33", lineHeight: 1.55, whiteSpace: "pre-wrap", fontFamily: "'JetBrains Mono', monospace" }}>{result.email}</div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "#A8A496", padding: "40px 0", textAlign: "center" }}>
                <div style={{ width: 56, height: 56, borderRadius: 15, border: "2px dashed #CBC8D4", display: "flex", alignItems: "center", justifyContent: "center", color: "#A8A4B0" }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 3.5V2.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M9 9h6M9 13h6M9 17h3" /></svg>
                </div>
                <div style={{ fontSize: 14, fontWeight: 500, maxWidth: 280, lineHeight: 1.5 }}>Fill the form and run the full review. Each check streams in, ending on a final decision.</div>
              </div>
            )}
          </section>
        </div>
      ) : (
        /* HISTORY */
        <div style={{ padding: "28px 32px", maxWidth: 980, margin: "0 auto", width: "100%" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 26 }}>
            {(["APPROVED", "PENDING", "REJECTED"] as const).map((d) => (
              <div key={d} style={{ ...UI.card, borderTop: `4px solid ${DEC_TONE[d].color}`, padding: "20px 22px" }}>
                <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: "-0.02em", color: DEC_TONE[d].color, lineHeight: 1 }}>{runs.filter((r) => r.decision === d).length}</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#6B6F76", marginTop: 6 }}>{d[0] + d.slice(1).toLowerCase()}</div>
              </div>
            ))}
          </div>
          <div style={{ ...UI.caps, marginBottom: 12 }}>Past runs</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {runs.length === 0 && <div style={{ color: "#A8A496", fontSize: 14, padding: "30px 0", textAlign: "center" }}>No runs yet — run a review.</div>}
            {runs.map((r) => (
              <button key={r.id} onClick={() => replay(r.id)} style={{ textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 16, background: "#fff", border: "1px solid #E8E4DA", borderRadius: 12, padding: "14px 18px" }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: DEC_TONE[r.decision].color, flex: "none" }} />
                <div style={{ width: 210, flex: "none", minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#20232A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.vendor}</div>
                  <div style={{ fontSize: 11, color: "#A8A4B0", fontWeight: 500, fontFamily: "'JetBrains Mono', monospace" }}>{r.id} · {r.ts}</div>
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500, color: "#5C6066", borderLeft: "1px solid #EFEAE0", paddingLeft: 16 }}>{r.headline}</div>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: DEC_TONE[r.decision].color, background: DEC_TONE[r.decision].bg, padding: "5px 11px", borderRadius: 999, flex: "none" }}>{r.decision}</span>
                <span style={{ fontSize: 12, color: "#B8B4A8", flex: "none" }}>Replay →</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
