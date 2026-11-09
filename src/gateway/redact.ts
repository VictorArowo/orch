// A second line of defence: anything that looks like an API key is masked
// before it reaches an event, a log line or an error message.
const PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{8,}/g,
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
];

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  for (const p of PATTERNS) out = out.replace(p, "[redacted]");
  return out;
}
