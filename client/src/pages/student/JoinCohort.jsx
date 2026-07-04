import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { joinCohort, logout as apiLogout } from '../../api';

const CODE_LENGTH = 6;

export default function JoinCohort() {
  const { setUser, user } = useAuth();
  const navigate = useNavigate();
  const [digits, setDigits] = useState(Array(CODE_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);
  const boxRefs = useRef([]);
  const code = digits.join('');

  const submitCode = async (codeValue) => {
    setLoading(true);
    setError('');
    try {
      const res = await joinCohort(codeValue);
      setSuccess(res.data.cohort);
      // Update auth context so cohortId is populated
      if (user) setUser({ ...user, cohortId: res.data.cohort.id });
      setTimeout(() => navigate('/student/dashboard', { replace: true }), 1500);
    } catch (err) {
      setError(err?.response?.data?.error || 'Invalid code. Please try again.');
      // Mistyped/invalid code — clear everything so the student can retry from scratch.
      setDigits(Array(CODE_LENGTH).fill(''));
      boxRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const fillFrom = (startIndex, chars) => {
    const next = [...digits];
    let i = startIndex;
    for (const ch of chars) {
      if (i >= CODE_LENGTH) break;
      next[i] = ch;
      i += 1;
    }
    setDigits(next);
    const focusIndex = Math.min(i, CODE_LENGTH - 1);
    boxRefs.current[focusIndex]?.focus();
    // Auto-submit the moment all 6 boxes are filled — no button needed.
    if (next.every((d) => d !== '')) submitCode(next.join(''));
    return focusIndex;
  };

  const handleDigitChange = (index, e) => {
    const chars = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').split('');
    setError('');
    if (chars.length === 0) {
      setDigits((prev) => { const next = [...prev]; next[index] = ''; return next; });
      return;
    }
    const focusIndex = fillFrom(index, chars);
    boxRefs.current[focusIndex]?.select();
  };

  const handleDigitPaste = (index, e) => {
    const text = e.clipboardData.getData('text');
    const chars = text.toUpperCase().replace(/[^A-Z0-9]/g, '').split('');
    if (chars.length === 0) return;
    e.preventDefault();
    setError('');
    fillFrom(index, chars);
  };

  const handleDigitKeyDown = (index, e) => {
    if (e.key === 'Enter') { if (code.length === CODE_LENGTH) submitCode(code); return; }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[index]) {
        setDigits((prev) => { const next = [...prev]; next[index] = ''; return next; });
      } else if (index > 0) {
        setDigits((prev) => { const next = [...prev]; next[index - 1] = ''; return next; });
        boxRefs.current[index - 1]?.focus();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && index > 0) boxRefs.current[index - 1]?.focus();
    if (e.key === 'ArrowRight' && index < CODE_LENGTH - 1) boxRefs.current[index + 1]?.focus();
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: "linear-gradient(rgba(20,10,10,0.45), rgba(20,10,10,0.45)), url('/login-background.jpg') center/cover no-repeat",
      }}
    >
      <div
        className="card"
        style={{
          width: 420,
          padding: '40px 36px',
          border: '1px solid var(--color-primary)',
          boxShadow: 'inset 0 0 24px 3px rgba(80, 0, 0, 0.35), 0 2px 12px rgba(0,0,0,0.10)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            style={{
              width: 64,
              height: 64,
              background: 'var(--color-primary)',
              borderRadius: '50%',
              margin: '0 auto 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <img
              src="/join-icon.png"
              alt=""
              style={{ width: 34, height: 34, objectFit: 'contain', filter: 'brightness(0) invert(1)' }}
            />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Join a Cohort</h1>
          <p style={{ color: 'var(--color-text-muted)', lineHeight: 1.6, fontSize: 14 }}>
            Enter the 6-character cohort code provided by your program director.
          </p>
        </div>

        {success ? (
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                background: 'var(--color-success-bg, #f0fdf4)',
                border: '1px solid var(--color-success, #22c55e)',
                borderRadius: 8,
                padding: '16px 20px',
                marginBottom: 16,
              }}
            >
              <div style={{ fontWeight: 600, color: 'var(--color-success, #16a34a)', marginBottom: 4 }}>
                Joined successfully!
              </div>
              <div style={{ fontSize: 14 }}>You joined <strong>{success.name}</strong>.</div>
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Redirecting to dashboard...</div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
                {digits.map((digit, i) => (
                  <input
                    key={i}
                    ref={(el) => { boxRefs.current[i] = el; }}
                    type="text"
                    inputMode="text"
                    value={digit}
                    onChange={(e) => handleDigitChange(i, e)}
                    onKeyDown={(e) => handleDigitKeyDown(i, e)}
                    onPaste={(e) => handleDigitPaste(i, e)}
                    onFocus={(e) => e.target.select()}
                    maxLength={1}
                    autoFocus={i === 0}
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={loading}
                    style={{
                      width: 48,
                      height: 56,
                      padding: 0,
                      fontSize: 26,
                      fontWeight: 700,
                      fontFamily: 'var(--font-mono)',
                      textAlign: 'center',
                      borderRadius: 8,
                      border: error
                        ? '2px solid var(--color-danger, #ef4444)'
                        : digit
                        ? '2px solid var(--color-primary)'
                        : '1px solid var(--color-border)',
                      background: 'var(--color-input-bg, var(--color-surface))',
                      color: 'var(--color-text)',
                      outline: 'none',
                      boxSizing: 'border-box',
                      textTransform: 'uppercase',
                    }}
                  />
                ))}
              </div>
              {loading && (
                <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13, marginTop: 12 }}>
                  Joining...
                </div>
              )}
              {error && (
                <div style={{ textAlign: 'center', color: 'var(--color-danger, #ef4444)', fontSize: 13, marginTop: 12 }}>
                  {error}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
