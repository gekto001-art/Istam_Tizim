import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setAccessToken, setLogoutHandler, tryRefresh } from './api';
import type { Me } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setMe(await api<Me>('/auth/me'));
  }, []);

  useEffect(() => {
    setLogoutHandler(() => {
      setAccessToken(null);
      setMe(null);
    });
    // Sahifa yangilanganda cookie orqali sessiyani tiklaymiz
    tryRefresh()
      .then((ok) => (ok ? reload() : undefined))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [reload]);

  const login = async (login: string, password: string) => {
    const r = await api<{ accessToken: string; user: Me }>('/auth/login', { method: 'POST', body: { login, password } });
    setAccessToken(r.accessToken);
    setMe(r.user);
  };

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setMe(null);
  };

  return <Ctx.Provider value={{ me, loading, login, logout, reload }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider yo\'q');
  return c;
}
