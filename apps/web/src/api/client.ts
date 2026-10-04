/** Thin typed fetch wrapper. Session is a HttpOnly cookie; the browser never stores tokens. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized && !path.startsWith('/api/auth')) onUnauthorized();
    const msg = (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null) ?? `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, signal ? { signal } : {});
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export const qs = (o: Record<string, string | number | undefined | null>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
