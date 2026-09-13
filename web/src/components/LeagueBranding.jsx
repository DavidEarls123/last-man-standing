import { useRef, useState } from 'react';
import { api } from '../api.js';
import { Alert, Card } from './ui.jsx';

const MAX_DIMENSION = 256;

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
    initialPicks: league.initialPicks,
  });
  const [logo, setLogo] = useState(undefined); // undefined = unchanged, null = remove
  const [preview, setPreview] = useState(league.logoUrl);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const dataUrl = await readCrest(file);
      setLogo(dataUrl);
      setPreview(dataUrl);
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
        initialPicks: Number(form.initialPicks),
        ...(logo === undefined ? {} : { logo }),
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

  const locked = league.entryClosed && league.role !== 'super_admin';

  return (
    <Card title="Your league's look">
      <form
        className="stack"
        onSubmit={save}
        style={{ '--brand': form.primaryColor, '--brand-2': form.secondaryColor }}
      >
        <label className="field">
          Title
          <input value={form.name} onChange={update('name')} maxLength={80} required />
        </label>
        <label className="field">
          Tagline (optional)
          <input
            value={form.tagline} onChange={update('tagline')} maxLength={120}
            placeholder="Last one standing drinks free"
          />
        </label>

        <div className="grid-2">
          <label className="field">
            Main colour
            <input type="color" value={form.primaryColor} onChange={update('primaryColor')} />
          </label>
          <label className="field">
            Second colour
            <input type="color" value={form.secondaryColor} onChange={update('secondaryColor')} />
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
              : <div className="logo-preview" style={{ display: 'grid', placeItems: 'center', fontSize: 26 }}>🏆</div>}
            <div className="grow stack" style={{ gap: 8 }}>
              <input ref={fileInput} type="file" accept="image/*" onChange={chooseFile} />
              {preview && (
                <button className="btn-ghost btn-sm" type="button" onClick={() => {
                  setLogo(null);
                  setPreview(null);
                  if (fileInput.current) fileInput.current.value = '';
                }}>Remove crest</button>
              )}
            </div>
          </div>
          <span className="tiny dim">Shrunk to 256px before upload. PNG, JPEG, WebP, GIF or SVG.</span>
        </div>

        <label className="field">
          Picks due before the first kick off
          <input
            type="number" min="1" max="10" value={form.initialPicks}
            onChange={update('initialPicks')} disabled={locked}
          />
          <span className="tiny dim">
            {locked
              ? 'Locked now the competition has started.'
              : 'Entrants choose this many rounds up front, then one at a time.'}
          </span>
        </label>

        <Alert tone="error">{error}</Alert>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save league look'}
        </button>
      </form>
    </Card>
  );
}
