const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

export default function LoginPage() {
  const handleGoogleLogin = () => {
    window.location.href = `${API_BASE}/api/auth/google`;
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
          width: 380,
          textAlign: 'center',
          padding: '40px 36px',
          border: '1px solid var(--color-primary)',
          boxShadow: 'inset 0 0 24px 3px rgba(80, 0, 0, 0.35), 0 2px 12px rgba(0,0,0,0.10)',
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            background: 'var(--color-primary)',
            borderRadius: '50%',
            margin: '0 auto 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <img
            src="/login-icon.png"
            alt=""
            style={{ width: 34, height: 34, objectFit: 'contain', filter: 'brightness(0) invert(1)' }}
          />
        </div>
        <h1 style={{ fontSize: 22, marginBottom: 6, fontWeight: 700 }}>
          ZLP Course Scheduler
        </h1>
        <p
          className="text-muted"
          style={{ marginBottom: 28, lineHeight: 1.5, fontSize: 16 }}
        >
          <i>College of Engineering</i>
        </p>
        <button
          onClick={handleGoogleLogin}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            width: '100%',
            padding: '10px 16px',
            background: '#fff',
            border: '1px solid #dadce0',
            borderRadius: 4,
            boxShadow: '0 1px 2px rgba(0,0,0,0.10)',
            cursor: 'pointer',
            fontSize: 15,
            fontFamily: "'Roboto', 'Arial', sans-serif",
            fontWeight: 500,
            color: '#3c4043',
            letterSpacing: 0.2,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 2px 6px rgba(0,0,0,0.18)'; e.currentTarget.style.borderColor = '#c6c6c6'; }}
          onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.10)'; e.currentTarget.style.borderColor = '#dadce0'; }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <g>
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
              <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
            </g>
          </svg>
          Sign in with Google
        </button>
        <p
          className="text-muted"
          style={{ marginTop: 16, fontSize: 12, lineHeight: 1.5 }}
        >
          Use your <strong>@tamu.edu</strong> Google account.
          <br />
          Must have a cohort access code to enroll.
        </p>
      </div>
    </div>
  );
}
