import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Alert, Card } from './ui.jsx';
import { leagueIcons } from '../lib/icons.js';

const MAX_DIMENSION = 256;

/**
 * Either no opening block, or 2 to 10 locked rounds. A block of one would be
 * indistinguishable from no block, so it is not offered.
 */
const OPENING_PICK_CHOICES = Array.from({ length: 9 }, (_, index) => index + 2);

/**
 * Shrinks a chosen crest to a small square PNG in the browser, so uploads stay
 * well inside the server's 256KB limit whatever the phone camera produced.
 * SVGs are sent through untouched — they are already tiny and scale better.
 */
function readCrest(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      if (file.type === 'image/svg+xml') return resolve(dataUrl);

      const image = new Image();
      image.onerror = () => reject(new Error('That file is not an image'));
      image.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export default function LeagueBranding({ league, onSaved, setToast }) {
  const [form, setForm] = useState({
    name: league.name,
    tagline: league.tagline ?? '',
    primaryColor: league.primaryColor,
    secondaryColor: league.secondaryColor,
    openingPicks: league.openingPicks,
  });
  const [logo, setLogo] = useState(undefined); // undefined = unchanged, null = remove
  const [preset, setPreset] = useState(league.logoPreset ?? null);
  const [icons, setIcons] = useState([]);
  const [preview, setPreview] = useState(league.logoUrl);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  useEffect(() => { leagueIcons().then(setIcons).catch(() => {}); }, []);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const dataUrl = await readCrest(file);
      setLogo(dataUrl);
      setPreview(dataUrl);
      setPreset(null); // an upload replaces a chosen icon
    } catch (readError) {
      setError(readError.message);
    }
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.patch(`/api/leagues/${league.id}`, {
        name: form.name,
        tagline: form.tagline || null,
        primaryColor: form.primaryColor,
        secondaryColor: form.secondaryColor,
        openingPicks: Number(form.openingPicks),
        ...(logo === undefined ? {} : { logo }),
        logoPreset: preset,
      });
      setLogo(undefined);
      setPreview(result.league.logoUrl ? `${result.league.logoUrl}?v=${Date.now()}` : null);
      setToast?.('League look saved');
      await onSaved?.();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy(false);
    }
  }

  const isSuperAdmin = league.role === 'super_admin';
  // Locked setup is read-only for the league admin. The platform admin edits
  // straight through it, with a warning so it is never done by accident.
  const readOnly = league.configLocked && !isSuperAdmin;
  const overriding = league.configLocked && isSuperAdmin;

  return (
    <Card title="Your league's look and rules">
      {readOnly && (
        <Alert tone="info">
          {league.configLockReason === 'competition_started'
            ? 'Locked when the competition kicked off — entrants are playing to these settings now.'
            : 'You have locked this setup, so it is fixed for your entrants.'}{' '}
          Ask the platform admin if something genuinely has to change.
        </Alert>
      )}
      {overriding && (
        <Alert tone="warn">
          This league's setup is locked. As platform admin your changes still go through, and they are
          recorded in the audit log.
        </Alert>
      )}
      <form
        className="stack"
        onSubmit={save}
        style={{ '--brand': form.primaryColor, '--brand-2': form.secondaryColor }}
      >
        <label className="field">
          Title
          <input value={form.name} onChange={update('name')} maxLength={80} required disabled={readOnly} />
        </label>
        <label className="field">
          Tagline (optional)
          <input
            value={form.tagline} onChange={update('tagline')} maxLength={120}
            placeholder="Last one standing drinks free" disabled={readOnly}
          />
        </label>

        <div className="grid-2">
          <label className="field">
            Main colour
            <input type="color" value={form.primaryColor} onChange={update('primaryColor')} disabled={readOnly} />
          </label>
          <label className="field">
            Second colour
            <input type="color" value={form.secondaryColor} onChange={update('secondaryColor')} disabled={readOnly} />
          </label>
        </div>
        <div className="swatch-row">
          <div className="swatch-preview" aria-hidden="true" />
          <span className="tiny dim">Live preview of your two colours</span>
        </div>

        <div className="field">
          Crest
          <div className="row">
            {preview
              ? <img className="logo-preview" src={preview} alt="League crest" />
              : (
                <div className="logo-preview" style={{ display: 'grid', placeItems: 'center', fontSize: 26 }}>
                  {preset ? icons.find((icon) => icon.key === preset)?.emoji ?? '🏆' : '🏆'}
                </div>
              )}
            <div className="grow stack" style={{ gap: 8 }}>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={chooseFile} disabled={readOnly} />
              {(preview || preset) && !readOnly && (
                <button className="btn-ghost btn-sm" type="button" onClick={() => {
                  setLogo(null);
                  setPreset(null);
                  setPreview(null);
                  if (fileInput.current) fileInput.current.value = '';
                }}>Clear crest</button>
              )}
            </div>
          </div>
          <span className="tiny dim">Shrunk to 256px before upload. PNG, JPEG, WebP or GIF.</span>
        </div>

        <div className="field">
          Or pick one
          <div className="icon-picker">
            {icons.map((icon) => (
              <button
                key={icon.key}
                type="button"
                title={`${icon.label} (${icon.group})`}
                aria-label={icon.label}
                aria-pressed={preset === icon.key}
                className={`icon-choice${preset === icon.key ? ' selected' : ''}`}
                disabled={readOnly}
                onClick={() => {
                  setPreset(icon.key);
                  setLogo(null);
                  setPreview(null);
                  if (fileInput.current) fileInput.current.value = '';
                }}
              >
                <span aria-hidden="true">{icon.emoji}</span>
              </button>
            ))}
          </div>
          <span className="tiny dim">
            Football, animals and a few others — no image needed.
          </span>
        </div>

        <label className="field">
          Opening block
          <select value={form.openingPicks} onChange={update('openingPicks')} disabled={readOnly}>
            <option value={0}>None — start as normal</option>
            {OPENING_PICK_CHOICES.map((count) => (
              <option key={count} value={count}>{count} locked rounds up front</option>
            ))}
          </select>
          <span className="tiny dim">
            Leave this alone for the ordinary weekly game. Choose a block and every entrant must
            pick those rounds before kick off, and cannot change them afterwards. Either way,
            picking further ahead is always allowed and never required.
          </span>
        </label>

        <Alert tone="error">{error}</Alert>
        {!readOnly && (
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : overriding ? 'Save (overriding the lock)' : 'Save league setup'}
          </button>
        )}
      </form>
    </Card>
  );
}
