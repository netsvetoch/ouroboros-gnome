// Review diagnostics only: never transform authored reviews, source documents or file bytes.
// Known token shapes follow the pinned primary secret_masking.SECRET_TOKEN_PATTERNS.
const masked = "***REDACTED***";
const metadata = new Set("count counts estimate estimates total totals budget budgets limit limits usage details id ids index type kind len length size num number".split(" "));
const key = (value: string) => value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
function secret(name: string): boolean {
  const normalized = key(name), parts = normalized.split("_");
  if (metadata.has(parts.at(-1)!)) return false;
  return /(?:authorization|auth_token|access_key|secret_key|password|passwd|passphrase|token|secret|apikey|credential|credentials|private_key|privatekey)$/u.test(normalized)
    || /(?:^|_)(?:api_key|client_secret)(?:_|$)/u.test(normalized);
}
const patterns = [
  /\bBearer\s+[A-Za-z0-9_\-./+=]{16,}/giu, /\bBasic\s+[A-Za-z0-9+/=]{16,}/giu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu, /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu, /\bgsk_[A-Za-z0-9]{20,}\b/gu, /\bhf_[A-Za-z0-9]{20,}\b/gu,
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/gu, /(?:(?<=bot)|\b)[0-9]{8,}:[A-Za-z0-9_-]{20,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----|$)/gu,
];
function text(value: string): string {
  let output = value;
  for (const pattern of patterns) output = output.replace(pattern, masked);
  output = output.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/giu, `$1${masked}:${masked}@`);
  output = output.replace(/([?&])([A-Za-z_][A-Za-z0-9_.-]*)(=)([^&#\s]+)/gu,
    (whole, prefix, name, separator) => secret(name) ? prefix + name + separator + masked : whole);
  return output.replace(/(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1(\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;}]+))/gu,
    (whole, quote, name, separator) => secret(name) ? quote + name + quote + separator + masked : whole);
}
export function reviewDiagnostic(value: unknown): unknown {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map(reviewDiagnostic);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, child]) =>
    [name, secret(name) && child !== null && child !== "" && child !== false ? masked : reviewDiagnostic(child)]));
  return value;
}
