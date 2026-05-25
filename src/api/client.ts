// Thin fetch wrapper. Every request from the app goes through here so that
// auth headers, base URL, error normalization, and (later) cancellation live
// in exactly one place.
//
// Pragmatic note: this is a tracer-bullet seam. Today the API layer resolves
// to mock data; tomorrow it'll resolve to real HTTP calls — without any tile
// component needing to change.

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const headers = {
    ...(init?.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers ?? {}),
  };
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers,
    ...init,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let parsed: unknown = body;
    let message = `${init?.method ?? 'GET'} ${path} → ${res.status}`;
    try {
      parsed = body ? JSON.parse(body) : undefined;
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const error = (parsed as { error?: unknown }).error;
        if (typeof error === 'string' && error.trim()) message = error;
      }
    } catch {
      if (body.trim()) message = body;
    }
    throw new ApiError(res.status, message, parsed);
  }

  // 204 = no content; let endpoints that return nothing call this as http<void>().
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Are we still on the mock backend? Flip VITE_USE_MOCK_API in .env to switch. */
export const useMockApi: boolean =
  (import.meta.env.VITE_USE_MOCK_API ?? 'true') !== 'false';
