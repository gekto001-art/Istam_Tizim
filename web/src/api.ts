// API mijozi: access token xotirada, refresh token httpOnly cookie'da.
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onLogout: (() => void) | null = null;

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const setLogoutHandler = (fn: () => void) => {
  onLogout = fn;
};

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) return false;
      const body = await r.json();
      accessToken = body.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401 && retry && !path.startsWith('/auth/login')) {
    if (await refresh()) return api<T>(path, opts, false);
    onLogout?.();
  }
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const details = Array.isArray(data.details) ? data.details : undefined;
    const msg = details?.length
      ? `${data.message}: ${details.map((d: { path: string; message: string }) => `${d.path} — ${d.message}`).join('; ')}`
      : data.message ?? 'Xatolik';
    throw new ApiError(r.status, data.code ?? 'ERROR', msg, data.details);
  }
  return data as T;
}

export const tryRefresh = refresh;
