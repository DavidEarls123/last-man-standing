import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { Spinner, Alert } from './components/ui.jsx';

const LeagueContext = createContext(null);

/**
 * Which league you are currently inside, published upwards so the bars at the
 * top of the page can say so. They sit outside the league's own provider —
 * they have to, they are there before a league is loaded — so the league
 * announces itself here rather than being read from below.
 */
const ActiveLeagueContext = createContext({ active: null, setActive: () => {} });

export function ActiveLeagueProvider({ children }) {
  const [active, setActive] = useState(null);
  return (
    <ActiveLeagueContext.Provider value={{ active, setActive }}>
      {children}
    </ActiveLeagueContext.Provider>
  );
}

export const useActiveLeague = () => useContext(ActiveLeagueContext);

/** Loads the "home" payload once per league and shares it with every tab. */
export function LeagueProvider({ leagueId, children }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/api/leagues/${leagueId}/home`);
      setState({ loading: false, data, error: null });
    } catch (error) {
      setState((previous) => ({ loading: false, data: previous.data, error: error.message }));
    }
  }, [leagueId]);

  useEffect(() => { load(); }, [load]);

  // Tell the bars above which league this is, and stop claiming it on the way
  // out, so stepping back to the league list clears the crumb with it.
  const { setActive } = useActiveLeague();
  const name = state.data?.league?.name;
  useEffect(() => {
    if (!name) return undefined;
    setActive({ id: leagueId, name });
    return () => setActive(null);
  }, [leagueId, name, setActive]);

  if (state.loading && !state.data) return <div className="content"><Spinner /></div>;
  if (!state.data) return <div className="content"><Alert tone="error">{state.error}</Alert></div>;

  return (
    <LeagueContext.Provider value={{ ...state.data, leagueId, reload: load }}>
      <LeagueTheme
        primary={state.data.league.primaryColor}
        secondary={state.data.league.secondaryColor}
      />
      <div className="grow">{children}</div>
    </LeagueContext.Provider>
  );
}

/**
 * Paints the league's two colours onto the document itself rather than a
 * wrapper, so the header and the tab bar change with the content. Step back
 * out to your own leagues and the platform's Floodlight pair returns.
 */
function LeagueTheme({ primary, secondary }) {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--brand', primary);
    root.style.setProperty('--brand-2', secondary);
    return () => {
      root.style.removeProperty('--brand');
      root.style.removeProperty('--brand-2');
    };
  }, [primary, secondary]);
  return null;
}

export const useLeague = () => useContext(LeagueContext) ?? {};
