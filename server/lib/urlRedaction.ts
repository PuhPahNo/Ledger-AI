const SENSITIVE_QUERY_KEYS = new Set(['secret', 'token', 'key', 'password']);

export function redactSensitiveUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) return rawUrl;

  const base = rawUrl.slice(0, queryIndex);
  const query = rawUrl.slice(queryIndex + 1);
  const parts = query.split('&').map((part) => {
    const [rawKey, ...rest] = part.split('=');
    const key = decodeURIComponent(rawKey).toLowerCase();
    if (!SENSITIVE_QUERY_KEYS.has(key)) return part;
    return `${rawKey}=${rest.length > 0 ? '[redacted]' : ''}`;
  });
  return `${base}?${parts.join('&')}`;
}
