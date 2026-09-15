import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Alert, Card } from './ui.jsx';
import InfoTip from './InfoTip.jsx';
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
    startGameweek: league.startGameweek,
    drawPolicy: league.drawPolicy,
    voidPolicy: league.voidPolicy,
    noPickPolicy: league.noPickPolicy,
    anonymousEntrants: league.anonymousEntrants,
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
        startGameweek: Number(form.startGameweek),
        drawPolicy: form.drawPolicy,
        voidPolicy: form.voidPolicy,
        noPickPolicy: form.noPickPolicy,
        anonymousEntrants: form.anonymousEntrants,
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
          <InfoTip label="Title">
            The name of your competition. It heads every page your players see, and goes in
            the emails and texts they get.
          </InfoTip>
          <input value={form.name} onChange={update('name')} maxLength={80} required disabled={readOnly} />
        </label>
        <label className="field">
          <InfoTip label="Tagline (optional)">
            One line under the title — the prize, the pub, the wind-up. Leave it blank if you
            would rather not have one.
          </InfoTip>
          <input
            value={form.tagline} onChange={update('tagline')} maxLength={120}
            placeholder="Last one standing drinks free" disabled={readOnly}
          />
        </label>

        <div className="grid-2">
          <label className="field">
            <InfoTip label="Main colour">
              Your league's main colour. Buttons, progress bars and highlights all take it, so
              the league looks like yours rather than the default green.
            </InfoTip>
            <input type="color" value={form.primaryColor} onChange={update('primaryColor')} disabled={readOnly} />
          </label>
          <label className="field">
            <InfoTip label="Second colour">
              The partner colour, used for gradients and accents alongside the main one. Pick
              something that sits well next to it.
            </InfoTip>
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
          <InfoTip label="Start gameweek">
            The Premier League gameweek your competition begins in. Entries close at the first
            kick off of that week, and that is round 1. You can only move this before anybody
            has picked.
          </InfoTip>
          <input
            type="number" min="1" max="38" value={form.startGameweek}
            onChange={update('startGameweek')} disabled={readOnly}
          />
        </label>

        <label className="field">
          <InfoTip label="Opening block">
            Leave this alone for the ordinary weekly game. Choose a block and every entrant must
            pick that many rounds before the first kick off, and cannot change them afterwards.
            Either way, picking further ahead is always allowed and never required.
          </InfoTip>
          <select value={form.openingPicks} onChange={update('openingPicks')} disabled={readOnly}>
            <option value={0}>None — start as normal</option>
            {OPENING_PICK_CHOICES.map((count) => (
              <option key={count} value={count}>{count} locked rounds up front</option>
            ))}
          </select>
        </label>

        <div className="stack">
          <label className="field">
            <InfoTip label="A draw">
              What happens when the club somebody picked draws. The usual Last One Standing rule
              is that only a win keeps you in, so a draw knocks you out — but some leagues let a
              draw pass.
            </InfoTip>
            <select value={form.drawPolicy} onChange={update('drawPolicy')} disabled={readOnly}>
              <option value="eliminate">Knocks you out</option>
              <option value="survive">Counts as surviving</option>
            </select>
          </label>

          <label className="field">
            <InfoTip label="Postponed or no fixture">
              What happens when a picked club's game is called off, or they have no game that
              week. The fair default is to tell that player to pick again from whatever has not
              kicked off yet, and give them their club back for a later round.
            </InfoTip>
            <select value={form.voidPolicy} onChange={update('voidPolicy')} disabled={readOnly}>
              <option value="reselect">Ask them to pick again</option>
              <option value="survive">Counts as surviving</option>
              <option value="eliminate">Knocks you out</option>
            </select>
          </label>

          <label className="field">
            <InfoTip label="No pick by the deadline">
              What happens to somebody who forgets. By default they are handed the first club
              they have not used yet in alphabetical order, so they stay in the game. The strict
              alternative is that missing the deadline puts them out.
            </InfoTip>
            <select value={form.noPickPolicy} onChange={update('noPickPolicy')} disabled={readOnly}>
              <option value="auto_alphabetical">Give them the next unused club (A–Z)</option>
              <option value="eliminate">Knocks them out</option>
            </select>
          </label>

          <div className="field">
            <InfoTip label="Anonymous entrants">
              On, players cannot see who else is playing or what anyone picked — the field is
              shown as a graph of how many are still in instead. You and the platform admin can
              still see everybody by name in here.
            </InfoTip>
            <label className="checkbox" style={{ marginTop: 4 }}>
              <input
                type="checkbox" checked={Boolean(form.anonymousEntrants)} disabled={readOnly}
                onChange={(event) => setForm({ ...form, anonymousEntrants: event.target.checked })}
              />
              <span>Hide entrants' names from each other</span>
            </label>
          </div>
        </div>

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
