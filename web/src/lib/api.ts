import type { Submission } from "./validators";

export interface ScanCheck { label: string; status: "pass" | "warn" | "fail"; message: string; }
export interface ScanResult {
  ok: boolean; method: string; chars: number; pages: number;
  filename: string; checks: ScanCheck[]; message?: string;
}
export interface Stage {
  stage: string; name: string; status: string; severity: string; message: string;
}
export interface RunResult {
  id: string; ts: string; vendor: string; decision: "APPROVED" | "PENDING" | "REJECTED";
  headline: string; results: Stage[]; issues: Stage[];
  email: string; summary: string; ai_used: boolean;
  submission?: Submission;
}
export interface SampleEntry { file: string; label: string; data: Submission & { documents?: unknown } }

export interface KnownVendor { id: string; legal_name: string; country: string; tax_id: string; iban: string; }
export interface BlockEntry { name: string; reason: string; }

// In dev this is empty -> relative /api -> Vite proxy. In prod (Vercel) set
// VITE_API_BASE to the Render backend URL so calls go straight there (keeps SSE
// streaming reliable; no proxy buffering). Trailing slash trimmed.
const API = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");

export async function getStatus(): Promise<{ ai: boolean }> {
  return (await fetch(`${API}/api/status`)).json();
}
export async function getVendors(): Promise<KnownVendor[]> {
  return (await fetch(`${API}/api/vendors`)).json();
}
export async function getBlocklist(): Promise<BlockEntry[]> {
  return (await fetch(`${API}/api/blocklist`)).json();
}
export async function getSamples(): Promise<SampleEntry[]> {
  return (await fetch(`${API}/api/samples`)).json();
}
export async function getRuns(): Promise<Pick<RunResult, "id" | "ts" | "vendor" | "decision" | "headline">[]> {
  return (await fetch(`${API}/api/runs`)).json();
}
export async function getRun(id: string): Promise<RunResult> {
  return (await fetch(`${API}/api/run/${id}`)).json();
}

/** Background single-document scan against the in-progress form. */
export async function scanDoc(
  kind: "bank_letter" | "incorporation_doc",
  file: File,
  s: Pick<Submission, "iban" | "account_name" | "legal_name">,
): Promise<ScanResult> {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("iban", s.iban || "");
  fd.append("account_name", s.account_name || "");
  fd.append("legal_name", s.legal_name || "");
  fd.append("file", file);
  const r = await fetch(`${API}/api/extract`, { method: "POST", body: fd });
  return r.json();
}

/** Full staged review via SSE. Calls onStage per stage, resolves with the final run. */
export async function runReview(
  submission: Submission,
  files: { bank_letter?: File; incorporation_doc?: File },
  onStage: (s: Stage & { intake?: boolean }) => void,
): Promise<RunResult> {
  const fd = new FormData();
  fd.append("submission", JSON.stringify(submission));
  fd.append("extractor", "local");
  if (files.incorporation_doc) fd.append("incorporation_doc", files.incorporation_doc);
  if (files.bank_letter) fd.append("bank_letter", files.bank_letter);

  const resp = await fetch(`${API}/api/run`, { method: "POST", body: fd });
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final: RunResult | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() || "";
    for (const chunk of chunks) {
      const ev = /event:\s*(\w+)/.exec(chunk)?.[1];
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const data = JSON.parse(dataLine.slice(5).trim());
      if (ev === "final") final = data as RunResult;
      else onStage(data);
    }
  }
  if (!final) throw new Error("no final result from server");
  return final;
}
