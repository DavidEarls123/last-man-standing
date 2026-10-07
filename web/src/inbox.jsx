import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * What this account has been sent, inside the app.
 *
 * With no mail server configured nothing actually leaves the machine, so a
 * deadline reminder exists only in the terminal the server runs in — which the
 * player, sitting at their own computer, has no way of reading. This is where
 * they read it instead. It is the same data either way: with email switched on
 * these are copies of what landed in their inbox.
 */
const InboxContext = createContext(null);

const POLL_MS = 20_000;

export function InboxProvider({ enabled, children }) {
  const [state, setState] = useState({ messages: [], unread: 0, loaded: false });
  const [arrived, setArrived] = useState(null);
  // Which ids we have already seen, so a reload does not re-announce them.
  const seen = useRef(null);

  const load = useCallback(async ({ announce = false } = {}) => {
    if (!enabled) return;
    try {
      const data = await api.get('/api/inbox');
      setState({ messages: data.messages, unread: data.unread, loaded: true });

      const ids = new Set(data.messages.map((message) => message.id));
      if (seen.current && announce) {
        const fresh = data.messages.filter((message) => !seen.current.has(message.id) && !message.read);
        if (fresh.length) {
          setArrived(fresh.length === 1
            ? fresh[0].subject
            : `${fresh.length} new messages`);
        }
      }
      seen.current = ids;
    } catch {
      // An inbox that cannot be reached is not worth interrupting anyone over.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      seen.current = null;
      setState({ messages: [], unread: 0, loaded: false });
      return undefined;
    }
    load();
    const timer = setInterval(() => load({ announce: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, load]);

  const markRead = useCallback(async (ids) => {
    await api.post('/api/inbox/read', ids ? { ids } : {});
    await load();
  }, [load]);

  return (
    <InboxContext.Provider value={{ ...state, reload: load, markRead, arrived, clearArrived: () => setArrived(null) }}>
      {children}
    </InboxContext.Provider>
  );
}

export const useInbox = () => useContext(InboxContext) ?? {
  messages: [], unread: 0, loaded: false, reload: () => {}, markRead: () => {},
};
