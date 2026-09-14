import { useId, useState } from 'react';

/**
 * A small "what is this?" button beside a setting. Tapping it opens a plain
 * explanation underneath — no hover-only tooltip, because half the people
 * setting a league up are doing it on a phone.
 */
export default function InfoTip({ label, children }) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <>
      <span className="field-head">
        <span>{label}</span>
        <button
          type="button"
          className="infotip-btn"
          aria-expanded={open}
          aria-controls={id}
          aria-label={`What is "${label}"?`}
          onClick={() => setOpen(!open)}
        >
          i
        </button>
      </span>
      {open && <span className="infotip-body tiny" id={id}>{children}</span>}
    </>
  );
}
