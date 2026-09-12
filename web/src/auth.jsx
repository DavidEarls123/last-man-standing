import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user: current } = await api.get('/api/auth/me');
      setUser(current);
      return current;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const value = useMemo(() => ({
    user,
    loading,
    refresh,
    setUser,
    async signIn(credentials) {
      const { user: signedIn } = await api.post('/api/auth/login', credentials);
      setUser(signedIn);
      return signedIn;
    },
    async register(details) {
      const { user: created } = await api.post('/api/auth/register', details);
      setUser(created);
      return created;
    },
    async signOut() {
      await api.post('/api/auth/logout');
      setUser(null);
    },
  }), [user, loading, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
