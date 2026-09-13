import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Alert, Card, Countdown, Spinner } from '../components/ui.jsx';

export default function JoinPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/api/leagues/preview/${code}`)
      .then(setPreview)
      .catch((loadError) => setError(loadError.message));
  }, [code]);

  async function join() {
    setBusy(true);
    setError('');
    try {
      const { league } = await api.post('/api/leagues/join', { code });
      navigate(`/leagues/${league.id}`);
    } catch (joinError) {
      setError(joinError.message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Card><Alert tone="error">{error}</Alert></Card>;
  if (!preview) return <Spinner />;

  return (
    <div style={{ '--brand': preview.primaryColor, '--brand-2': preview.secondaryColor }}>
    <Card>
      <div className="row" style={{ marginBottom: 10 }}>
        {preview.logoUrl
          ? <img className="logo-preview" src={preview.logoUrl} alt={`${preview.name} crest`} />
          : <div className="logo-preview" style={{ display: 'grid', placeItems: 'center', fontSize: 28 }}>🏆</div>}
        <div className="grow">
          <h1>{preview.name}</h1>
          {preview.tagline && <div className="small muted">{preview.tagline}</div>}
        </div>
      </div>
      <p className="muted small">
        Last Man Standing, starting at gameweek {preview.startGameweek}.
        {preview.openingPicks >= 2
          ? ` You pick winners for the first ${preview.openingPicks} rounds before kick off — those are final — then one round at a time.`
          : " Pick a winner each round before the gameweek's first kick off."}
        {' '}Lose once and you are out.
      </p>
      <div className="stack">
        <div className="small">
          <strong>{preview.totalEntries}</strong> entrant{preview.totalEntries === 1 ? '' : 's'} so far
        </div>
        {preview.entryClosed ? (
          <Alert tone="warn">Entries closed at the first kick off. You can no longer join this league.</Alert>
        ) : (
          <div className="small">
            Entries close in <Countdown deadline={preview.entryDeadline} />
          </div>
        )}
        <button className="btn-primary btn-block" onClick={join} disabled={busy || preview.entryClosed}>
          {busy ? 'Joining…' : 'Join this league'}
        </button>
      </div>
    </Card>
    </div>
  );
}
