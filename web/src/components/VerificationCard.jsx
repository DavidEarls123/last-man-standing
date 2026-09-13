import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Card, Empty, Spinner, useAsync } from './ui.jsx';
import { formatDateTime } from '../lib/format.js';

/**
 * The second opinion on every result: each pick recomputed from the fixture
 * list and compared with what was recorded.
 */
export default function VerificationCard({ leagueId, setToast }) {
  const { data, loading, error, reload } = useAsync(
    () => api.get(`/api/leagues/${leagueId}/verification`), [leagueId],
  );
  const [busy, setBusy] = useState(false);

  if (loading) return <Spinner />;
  if (error) return <Alert tone="error">{error}</Alert>;

  const errors = data.issues.filter((issue) => issue.severity === 'error');
  const warnings = data.issues.filter((issue) => issue.severity === 'warning');

  return (
    <Card title="Results double-check">
      {data.ok ? (
        <Alert tone="ok">
          All {data.picksChecked} pick{data.picksChecked === 1 ? '' : 's'} across{' '}
          {data.roundsSettled} settled round{data.roundsSettled === 1 ? '' : 's'} match the fixtures.
        </Alert>
      ) : (
        <Alert tone="error">
          {errors.length} result{errors.length === 1 ? '' : 's'} do not match the fixtures. Nothing has
          been changed automatically — the platform admin can correct the score or recompute the league.
        </Alert>
      )}

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="list" style={{ marginTop: 10 }}>
          {[...errors, ...warnings].slice(0, 20).map((issue, index) => (
            <div className="list-item" key={`${issue.code}-${index}`}>
              <span className={`badge ${issue.severity === 'error' ? 'badge-out' : 'badge-warn'}`}>
                {issue.severity === 'error' ? 'Wrong' : 'Check'}
              </span>
              <div className="grow">
                <div className="small strong">
                  {issue.entryName ?? 'League'}{issue.round ? ` · round ${issue.round}` : ''}
                </div>
                <div className="tiny muted">{issue.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {data.ok && data.issues.length === 0 && (
        <Empty>Checked {data.entriesChecked} entrants against the full fixture list.</Empty>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn-ghost btn-sm" type="button" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await api.post(`/api/leagues/${leagueId}/verification`);
            reload();
            setToast?.('Results re-checked');
          } finally {
            setBusy(false);
          }
        }}>Run the check again</button>
        <span className="tiny dim">Last run {formatDateTime(data.checkedAt)}</span>
      </div>
    </Card>
  );
}
