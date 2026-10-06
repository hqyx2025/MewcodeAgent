export function redactInstruction(text: string, sensitiveValues: readonly string[] = []): string {
  let safe = text.replace(
    /-----BEGIN [^\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n]*PRIVATE KEY-----|$)/g,
    '[REDACTED]',
  );
  safe = safe.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
  for (const value of sensitiveValues)
    if (value.length >= 12) safe = safe.replaceAll(value, '[REDACTED]');
  return safe;
}
