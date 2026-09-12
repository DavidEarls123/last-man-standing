import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { Spinner, Alert } from './components/ui.jsx';

const LeagueContext = createContext(null);

/** Loads the "home" payload once per league and shares it with every tab. */
export function LeagueProvider({ leagueId, children }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/api/leagues/${leagueId}/home`);
      setState({ loading: false, data, error: null });
    } catch (error) {
      setState({ loading: false, data: null, error: error.message });
    }
  }, [leagueId]);

  useEffect(() => { load(); }, [load]);

  if (state.loading) return <div className="content"><Spinner /></div>;
  if (state.error) return <div className="content"><Alert tone="error">{state.error}</Alert></div>;

  return (
    <LeagueContext.Provider value={{ ...state.data, leagueId, reload: load }}>
      {children}
    </LeagueContext.Provider>
  );
}

export const useLeague = () => useContext(LeagueContext) ?? {};
