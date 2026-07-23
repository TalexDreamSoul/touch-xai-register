"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, clearToken, getToken, setToken, type Health } from "./api";

type AuthState = {
  loading: boolean;
  authed: boolean;
  authRequired: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const h = await api<Health>("/api/health");
      setAuthRequired(!!h.auth);
      if (!h.auth) {
        setAuthed(true);
        return;
      }
      const tok = getToken();
      if (!tok) {
        setAuthed(false);
        return;
      }
      // probe a protected endpoint
      await api("/api/config");
      setAuthed(true);
    } catch {
      setAuthed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (token: string) => {
      setToken(token.trim());
      await api("/api/config");
      setAuthed(true);
      setAuthRequired(true);
    },
    [],
  );

  const logout = useCallback(() => {
    clearToken();
    setAuthed(false);
  }, []);

  const value = useMemo(
    () => ({ loading, authed, authRequired, login, logout, refresh }),
    [loading, authed, authRequired, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
