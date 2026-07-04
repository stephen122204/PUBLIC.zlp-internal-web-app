import { useState, useEffect, useCallback } from 'react';
import {
  getCohorts,
  getInviteLinks,
  generateInviteLink,
  revokeInviteLink,
  regenerateInviteLink,
} from '../../api';

function badgeClass(status) {
  if (status === 'active') return 'badge badge-active';
  if (status === 'expired') return 'badge badge-expired';
  if (status === 'revoked') return 'badge badge-revoked';
  return 'badge badge-none';
}

function resolveStatus(inv) {
  if (inv.status === 'active' && new Date(inv.expiresAt) < new Date()) return 'expired';
  return inv.status;
}

export default function AdminInviteLink() {
  const [cohorts, setCohorts] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [invites, setInvites] = useState([]);
  const [activeInvite, setActiveInvite] = useState(null);
  const [latestUrl, setLatestUrl] = useState('');
  const [cohortsLoading, setCohortsLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getCohorts().then((res) => {
      setCohorts(res.data);
      if (res.data.length > 0) setSelectedId(res.data[0]._id);
    }).finally(() => setCohortsLoading(false));
  }, []);

  const loadInvites = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    setError('');
    setLatestUrl('');
    try {
      const res = await getInviteLinks(selectedId);
      const list = res.data;
      setInvites(list);
      const active = list.find((i) => resolveStatus(i) === 'active');
      setActiveInvite(active || null);
    } catch {
      setError('Failed to load invite links.');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { loadInvites(); }, [loadInvites]);

  const handleGenerate = async () => {
    setActionLoading(true);
    setError('');
    try {
      const res = await generateInviteLink(selectedId);
      setLatestUrl(res.data.inviteUrl);
      await loadInvites();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to generate invite link.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegenerate = async () => {
    setActionLoading(true);
    setError('');
    try {
      const res = await regenerateInviteLink(selectedId);
      setLatestUrl(res.data.inviteUrl);
      await loadInvites();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to regenerate invite link.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (!activeInvite) return;
    if (!window.confirm('Revoke this invite link? Students will no longer be able to use it.')) return;
    setActionLoading(true);
    setError('');
    try {
      await revokeInviteLink(activeInvite._id);
      setLatestUrl('');
      await loadInvites();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to revoke.');
    } finally {
      setActionLoading(false);
    }
  };

  const copyLink = () => {
    const displayUrl = activeInvite?.inviteUrl || latestUrl;
    navigator.clipboard.writeText(displayUrl).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    });
  };

  const copyMessage = () => {
    const displayUrl = activeInvite?.inviteUrl || latestUrl;
    const msg = `Please use this link to join your ZLP scheduler cohort and submit your planned courses. Sign in with your TAMU Google account. The link expires in 7 days:\n\n${displayUrl}`;
    navigator.clipboard.writeText(msg).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const selectedCohort = cohorts.find((c) => c._id === selectedId);
  const displayUrl = activeInvite?.inviteUrl || latestUrl;

  return (
    <>
      <div className="page-header">
        <h1>Invite Link</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="cohort-select-row">
        <label>Cohort:</label>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          {cohorts.map((c) => (
            <option key={c._id} value={c._id}>
              {c.name}{c.term ? ` — ${c.term}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="alert alert-info" style={{ marginBottom: 20 }}>
        Invite links expire after <strong>7 days</strong>. Only one active link per cohort.
        Generating a new link revokes the previous one.
      </div>

      {(cohortsLoading || loading) ? (
        <div className="empty-state"><p>Loading…</p></div>
      ) : (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>
            {selectedCohort?.name} — Current Invite Link
          </div>

          {displayUrl ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <div className="text-muted text-sm" style={{ marginBottom: 5 }}>Invite URL</div>
                <input
                  type="text"
                  readOnly
                  value={displayUrl}
                  className="invite-url-box"
                  style={{ width: '100%', cursor: 'text' }}
                  onFocus={(e) => e.target.select()}
                />
              </div>
              {activeInvite && (
                <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
                  <div>
                    <div className="text-muted text-sm">Status</div>
                    <span className={badgeClass(resolveStatus(activeInvite))}>
                      {resolveStatus(activeInvite)}
                    </span>
                  </div>
                  <div>
                    <div className="text-muted text-sm">Expires</div>
                    <div className="text-sm">
                      {new Date(activeInvite.expiresAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn-primary btn-sm" onClick={copyLink}>
                  {copiedLink ? '✓ Link Copied!' : 'Copy Link'}
                </button>
                <button className="btn-secondary btn-sm" onClick={copyMessage}>
                  {copied ? '✓ Copied!' : 'Copy Invite Message'}
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={handleRegenerate}
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Regenerating…' : 'Regenerate Link'}
                </button>
                {activeInvite && resolveStatus(activeInvite) === 'active' && (
                  <button
                    className="btn-danger btn-sm"
                    onClick={handleRevoke}
                    disabled={actionLoading}
                  >
                    Revoke Link
                  </button>
                )}
              </div>
            </>
          ) : (
            <div>
              <p className="text-muted" style={{ marginBottom: 14 }}>
                No active invite link. Generate one to invite students.
              </p>
              <button
                className="btn-primary"
                onClick={handleGenerate}
                disabled={actionLoading}
              >
                {actionLoading ? 'Generating…' : 'Generate Invite Link'}
              </button>
            </div>
          )}
        </div>
      )}

      {invites.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '16px 20px 12px', fontWeight: 600 }}>Link History</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Created By</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr key={inv._id}>
                    <td>{selectedCohort?.name}</td>
                    <td>
                      <span className={badgeClass(resolveStatus(inv))}>
                        {resolveStatus(inv)}
                      </span>
                    </td>
                    <td className="text-sm">{new Date(inv.createdAt).toLocaleDateString()}</td>
                    <td className="text-sm">{new Date(inv.expiresAt).toLocaleDateString()}</td>
                    <td className="text-sm">{inv.createdBy?.name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
