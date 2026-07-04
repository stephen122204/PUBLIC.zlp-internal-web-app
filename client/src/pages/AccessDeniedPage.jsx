import { useSearchParams, Link } from 'react-router-dom';

const REASON_MESSAGES = {
  non_tamu_email: {
    title: 'Non-TAMU Email',
    message:
      'Only @tamu.edu Google accounts are allowed. Please sign in with your Texas A&M University Google account.',
  },
  no_cohort_access: {
    title: 'No Cohort Access',
    message:
      'You do not have access to a cohort. Ask your ZLP administrator for an invite link.',
  },
  no_invite: {
    title: 'No Invite Link',
    message:
      'Students must join through a valid invite link. Please contact your ZLP administrator for access.',
  },
  invalid_invite: {
    title: 'Invalid or Expired Invite',
    message:
      'This invite link is invalid, expired, or has been revoked. Please request a new link from your administrator.',
  },
  expired: {
    title: 'Invite Link Expired',
    message: 'This invite link has expired. Please request a new link from your administrator.',
  },
  revoked: {
    title: 'Invite Link Revoked',
    message: 'This invite link has been revoked. Please request a new link from your administrator.',
  },
  already_in_cohort: {
    title: 'Already in a Cohort',
    message:
      'You are already assigned to a different cohort. A student can only belong to one cohort.',
  },
  not_admin: {
    title: 'Access Denied',
    message: 'This page is for administrators only.',
  },
  not_student: {
    title: 'Access Denied',
    message: 'This page is for students only.',
  },
  error: {
    title: 'Something Went Wrong',
    message: 'An unexpected error occurred. Please try again.',
  },
};

export default function AccessDeniedPage() {
  const [params] = useSearchParams();
  const reason = params.get('reason') || 'error';
  const info = REASON_MESSAGES[reason] || REASON_MESSAGES.error;

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
        <div style={{ fontSize: 48, marginBottom: 16 }}>&#128683;</div>
        <h1 style={{ fontSize: 20, marginBottom: 10, fontWeight: 700 }}>
          {info.title}
        </h1>
        <p
          style={{ color: 'var(--color-text-muted)', lineHeight: 1.6, marginBottom: 28 }}
        >
          {info.message}
        </p>
        <Link to="/">
          <button className="btn-primary">Back to Login</button>
        </Link>
      </div>
    </div>
  );
}
