import { useState, useEffect, useCallback } from 'react';
import {
  getCohorts,
  getJoinCode,
  generateJoinCode,
  regenerateJoinCode,
  setCustomJoinCode,
  setJoinCodeEnabled,
} from '../../api';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function AdminJoinCode() {
  const [cohorts, setCohorts] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [data, setData] = useState(null);       // { joinCode, joinCodeEnabled, archived, ... }
  const [cohortsLoading, setCohortsLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [customCode, setCustomCode] = useState('');
  const [customError, setCustomError] = useState('');

  useEffect(() => {
    getCohorts().then((res) => {
      setCohorts(res.data);
      if (res.data.length > 0) setSelectedId(res.data[0]._id);
    }).finally(() => setCohortsLoading(false));
  }, []);

  const loadCode = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    setError('');
    setData(null);
    setCustomCode('');
    setCustomError('');
    try {
      const res = await getJoinCode(selectedId);
      setData(res.data);
    } catch {
      setError('Failed to load join code.');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { loadCode(); }, [loadCode]);

  const handleGenerate = async () => {
    setActionLoading(true);
    setError('');
    try {
      const res = await generateJoinCode(selectedId);
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to generate code.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegenerate = async () => {
    setActionLoading(true);
    setError('');
    try {
      const res = await regenerateJoinCode(selectedId);
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to regenerate code.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetCustom = async () => {
    const val = customCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (val.length !== 6) {
      setCustomError('Code must be exactly 6 letters or numbers.');
      return;
    }
    setActionLoading(true);
    setCustomError('');
    setError('');
    try {
      const res = await setCustomJoinCode(selectedId, val);
      setData(res.data);
      setCustomCode('');
    } catch (err) {
      const msg = err?.response?.data?.error || 'Failed to set custom code.';
      setCustomError(msg);
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!data) return;
    setActionLoading(true);
    setError('');
    try {
      const res = await setJoinCodeEnabled(selectedId, !data.joinCodeEnabled);
      setData((prev) => ({ ...prev, ...res.data }));
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to update.');
    } finally {
      setActionLoading(false);
    }
  };

  const copyCode = () => {
    if (!data?.joinCode) return;
    navigator.clipboard.writeText(data.joinCode).then(() => {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2500);
    });
  };

  const isArchived = data?.archived;
  const hasCode = !!data?.joinCode;

  return (
    <div style={{ maxWidth: 600, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 4 }}>Join Code</h2>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 14, marginBottom: 24 }}>
      </p>

      {/* Cohort selector */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Cohort</label>
        {cohortsLoading ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>Loading cohorts...</div>
        ) : (
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="input"
            style={{ maxWidth: 380 }}
          >
            {cohorts.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}{c.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading && <div style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>Loading...</div>}

      {error && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      {data && !loading && (
        <>
          {isArchived && (
            <div
              className="alert alert-warning"
              style={{ marginBottom: 20 }}
            >
              Archived cohorts cannot be joined. Generate and enable controls are disabled.
            </div>
          )}

          {/* Everything below is one connected task — manage this cohort's join code —
              so it lives in a single card with dividers between subsections rather
              than a stack of separate cards. */}
          <div className="card" style={{ padding: '24px 28px' }}>
            {/* Current code display */}
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: '#1a1a1a', letterSpacing: '0.08em', marginBottom: 8 }}>
            </div>
            {hasCode ? (
              <>
                <div style={{ textAlign: 'center', marginBottom: 16 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 48,
                      fontWeight: 700,
                      letterSpacing: '0.3em',
                      textAlign: 'center',
                      color: data.joinCodeEnabled ? 'var(--color-text)' : 'var(--color-text-muted)',
                      lineHeight: 1.2,
                      border: '2px solid #1a1a1a',
                      borderRadius: 8,
                      // Letter-spacing adds trailing space after the last character too,
                      // which visually pushes the text left — trim the right padding to
                      // compensate so the code reads as centered in the box.
                      padding: '8px calc(32px - 0.3em) 8px 32px',
                    }}
                  >
                    {data.joinCode}
                  </span>
                </div>
                {data.joinCodeEnabled && data.joinCodeExpiresAt && (
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                    Expires {formatDate(data.joinCodeExpiresAt)}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', marginTop: 20 }}>
                  {!isArchived && (
                    <button
                      className="btn-sm"
                      onClick={handleToggleEnabled}
                      disabled={actionLoading}
                      style={data.joinCodeEnabled
                        ? { color: '#fff', background: '#dc2626', borderColor: '#dc2626' }
                        : { color: '#fff', background: '#16a34a', borderColor: '#16a34a' }
                      }
                    >
                      {data.joinCodeEnabled ? 'Disable' : 'Enable'}
                    </button>
                  )}
                  {!isArchived && (
                    <button
                      className="btn-sm"
                      onClick={handleRegenerate}
                      disabled={actionLoading}
                      style={{ color: '#fff', background: '#7a2e2e' }}
                    >
                      {actionLoading ? 'Regenerating...' : 'Regenerate Code'}
                    </button>
                  )}
                </div>
                {data.joinCodeUpdatedAt && (
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    Updated {formatDate(data.joinCodeUpdatedAt)}
                  </div>
                )}
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
                  Codes are active for 3 days after enabling. Re-enable at any time to reset the window.
                </div>
                {!isArchived && (
                  <div style={{ marginTop: 2, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    <i>Note: regenerating a code deactivates the previous one.</i>
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 15, padding: '12px 0' }}>
                No join code created yet.
              </div>
            )}

            {/* Generate — only shown before a code exists; once a code exists, Regenerate
                lives inline in the button row above. */}
            {!isArchived && !hasCode && (
              <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 24, paddingTop: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>Generate Code</div>
                <button className="btn-primary btn-sm" onClick={handleGenerate} disabled={actionLoading}>
                  {actionLoading ? 'Generating...' : 'Generate Code'}
                </button>
              </div>
            )}

            {/* Custom code */}
            {!isArchived && (
              <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 24, paddingTop: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Set Custom Code</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ width: 140 }}>
                    <input
                      type="text"
                      value={customCode}
                      onChange={(e) => {
                        const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                        setCustomCode(val);
                        setCustomError('');
                      }}
                      maxLength={6}
                      placeholder="ZLPJ27"
                      className="input"
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 20,
                        letterSpacing: '0.15em',
                        width: 140,
                        textTransform: 'uppercase',
                        borderColor: customError ? 'var(--color-danger, #ef4444)' : undefined,
                      }}
                    />
                    {customError && (
                      <div style={{ color: 'var(--color-danger, #ef4444)', fontSize: 12, marginTop: 4 }}>
                        {customError}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                      {customCode.length}/6 &mdash; letters and numbers only
                    </div>
                  </div>
                  <button
                    className="btn-primary btn-sm"
                    style={{ marginTop: 4 }}
                    onClick={handleSetCustom}
                    disabled={actionLoading || customCode.length !== 6}
                  >
                    {actionLoading ? 'Saving...' : 'Set Code'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
