export function normalizeSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function fingerprintFinding(
  reviewerKind: string,
  severity: string,
  summary: string,
  path?: string,
  citation?: string,
): Promise<string> {
  const parts: string[] = [
    normalizeField(reviewerKind),
    normalizeField(severity),
    normalizeSummary(summary),
  ];
  if (path) parts.push(path.toLowerCase());
  if (citation) parts.push(citation.toLowerCase());
  const input = parts.join('|');
  return sha256Hex(input);
}

function normalizeField(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  return hexEncode(hashBuffer);
}

function hexEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
