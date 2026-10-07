import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Pick somebody who already has an account.
 *
 * Handing a league over used to mean typing an exact email address and being
 * told off if it was not already registered — which is no help at all when you
 * cannot remember whether somebody signed up, or how they spelled it. Search
 * their name instead and choose from what exists.
 */
export default function PersonPicker({ value, onChange, placeholder = 'Search by name or email' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const box = useRef(null);

  // Close when the click lands anywhere else, or the list hangs over the page.
  useEffect(() => {
    const away = (event) => { if (box.current && !box.current.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return undefined; }
    // Wait for a pause in typing rather than searching on every keystroke.
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api.get(`/api/admin/users?q=${encodeURIComponent(query.trim())}`);
        setResults(data.users.slice(0, 8));
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  if (value) {
    return (
      <div className="row-tight picked-person">
        <span className="grow">
          <span className="strong">{value.displayName}</span>
          <span className="tiny dim"> {value.email || value.phone}</span>
        </span>
        <button className="btn-ghost btn-sm" type="button" onClick={() => { onChange(null); setQuery(''); }}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="picker" ref={box}>
      <input
        value={query}
        placeholder={placeholder}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => results.length && setOpen(true)}
        autoComplete="off"
      />
      {open && (
        <div className="picker-list">
          {results.length === 0 && !searching && (
            <div className="picker-empty">
              Nobody matches “{query}”. They need an account first — add one under People.
            </div>
          )}
          {results.map((person) => (
            <button
              key={person.id}
              type="button"
              className="picker-option"
              // On mousedown, not click: the outside-click watcher above fires
              // on mousedown too, and a click that lands after the list has
              // been torn down never reaches React. preventDefault stops the
              // input stealing focus back on the way through.
              onMouseDown={(event) => { event.preventDefault(); onChange(person); setOpen(false); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onChange(person);
                  setOpen(false);
                }
              }}
            >
              <span className="strong">{person.displayName}</span>
              <span className="tiny dim">
                {person.email || person.phone}
                {person.adminOf?.length > 0 && ` · runs ${person.adminOf.length} league${person.adminOf.length === 1 ? '' : 's'}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
