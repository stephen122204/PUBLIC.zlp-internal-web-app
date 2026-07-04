import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { validateInvite } from '../api';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

export default function JoinPage() {
  const { token } = useParams();
  const [status, setStatus] = useState('loading'); // loading | valid | invalid
  const [cohort, setCohort] = useState(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      setReason('not_found');
      return;
    }
    validateInvite(token)
      .then((res) => {
        if (res.data.valid) {
          setCohort(res.data.cohort);
          setStatus('valid');
        } else {
          setReason(res.data.reason || 'invalid');
          setStatus('invalid');
        }
      })
      .catch((err) => {
        const r = err?.response?.data?.reason || 'invalid';
        setReason(r);
        setStatus('invalid');
      });
  }, [token]);

  const handleJoin = () => {
    window.location.href = `${API_BASE}/api/auth/google?token=${encodeURIComponent(token)}`;
  };

  if (status === 'loading') {
    return (
      <div className="loading-screen">Validating invite link...</div>
    );
  }

  const invalidMessages = {
    revoked: 'This invite link has been revoked by an administrator.',
    expired: 'This invite link has expired (links are valid for 7 days).',
    not_found: 'This invite link does not exist or is invalid.',
  };

  if (status === 'invalid') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg)',
        }}
      >
        <div
          className="card"
          style={{ width: 420, textAlign: 'center', padding: '40px 36px' }}
        >
          <div style={{ fontSize: 48, marginBottom: 16 }}>&#9888;&#65039;</div>
          <h1 style={{ fontSize: 20, marginBottom: 10, fontWeight: 700 }}>
            Invalid Invite Link
          </h1>
          <p style={{ color: 'var(--color-text-muted)', lineHeight: 1.6, marginBottom: 28 }}>
            {invalidMessages[reason] ||
              'This invite link is not valid. Please request a new one from your ZLP administrator.'}
          </p>
          <Link to="/">
            <button className="btn-secondary">Back to Login</button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg)',
      }}
    >
      <div
        className="card"
        style={{ width: 420, textAlign: 'center', padding: '40px 36px' }}
      >
        <div style={{ fontSize: 48, marginBottom: 16 }}>&#128279;</div>
        <h1 style={{ fontSize: 20, marginBottom: 6, fontWeight: 700 }}>
          You&apos;ve Been Invited
        </h1>
        {cohort && (
          <div
            style={{
              background: '#fdf0f0',
              border: '1px solid #f5caca',
              borderRadius: 8,
              padding: '12px 16px',
              margin: '16px 0',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 16 }}>{cohort.name}</div>
            <div className="text-muted" style={{ marginTop: 2 }}>
              {cohort.term}
            </div>
          </div>
        )}
        <p
          style={{
            color: 'var(--color-text-muted)',
            lineHeight: 1.6,
            marginBottom: 24,
            fontSize: 14,
          }}
        >
          Sign in with your <strong>@tamu.edu</strong> Google account to join
          this ZLP Scheduler cohort.
        </p>
        <button
          className="btn-primary"
          style={{ width: '100%', padding: '11px 0', fontSize: 15 }}
          onClick={handleJoin}
        >
          Continue with Google
        </button>
        <p className="text-muted" style={{ marginTop: 14, fontSize: 12 }}>
          You must use your Texas A&amp;M University Google account.
        </p>
      </div>
    </div>
  );
}
