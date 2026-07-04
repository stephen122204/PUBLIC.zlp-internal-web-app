import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useViewMode } from '../context/ViewModeContext';

export function RequireAdmin({ children }) {
  const { user, loading } = useAuth();
  const { viewMode } = useViewMode();
  if (loading) return <div className="loading-screen">Loading...</div>;
  if (!user) return <Navigate to="/" replace />;
  // Admin in demo student mode — block admin pages
  if ((user.role === 'admin' || user.role === 'developer') && viewMode === 'demoStudent') {
    return <Navigate to="/student/dashboard" replace />;
  }
  if (user.role !== 'admin' && user.role !== 'developer') {
    if (user.role === 'student') return <Navigate to="/student/dashboard" replace />;
    return <Navigate to="/" replace />;
  }
  return children;
}

export function RequireDeveloper({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen">Loading...</div>;
  if (!user) return <Navigate to="/" replace />;
  if (user.role !== 'developer') {
    return <Navigate to="/access-denied?reason=not_developer" replace />;
  }
  return children;
}

export function RequireStudent({ children }) {
  const { user, loading } = useAuth();
  const { viewMode, isDeveloper } = useViewMode();
  if (loading) return <div className="loading-screen">Loading...</div>;
  if (!user) return <Navigate to="/" replace />;
  // Admin in demo student mode — allow access to student pages.
  if ((user.role === 'admin' || user.role === 'developer') && viewMode === 'demoStudent') {
    return children;
  }
  // Developer in student-view preview — allow access.
  if (isDeveloper) {
    const effectiveMode = viewMode === 'student' || localStorage.getItem('zlp_viewmode') === 'student'
      ? 'student' : 'admin';
    if (effectiveMode === 'student') return children;
    return <Navigate to="/admin/cohorts" replace />;
  }
  if (user.role !== 'student') return <Navigate to="/admin/cohorts" replace />;
  if (!user.cohortId) return <Navigate to="/join-cohort" replace />;
  return children;
}

export function RequireGuest({ children }) {
  const { user, loading } = useAuth();
  const { viewMode, isDeveloper } = useViewMode();
  if (loading) return <div className="loading-screen">Loading...</div>;
  if (user?.role === 'admin') {
    if (viewMode === 'demoStudent') return <Navigate to="/student/dashboard" replace />;
    return <Navigate to="/admin/cohorts" replace />;
  }
  if (user?.role === 'developer') {
    if (viewMode === 'demoStudent') return <Navigate to="/student/dashboard" replace />;
    if (isDeveloper && viewMode === 'student') return <Navigate to="/student/dashboard" replace />;
    return <Navigate to="/admin/cohorts" replace />;
  }
  if (user?.role === 'student' && user?.cohortId) return <Navigate to="/student/dashboard" replace />;
  if (user?.role === 'student' && !user?.cohortId) return <Navigate to="/join-cohort" replace />;
  return children;
}

export function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen">Loading...</div>;
  if (!user) return <Navigate to="/" replace />;
  return children;
}
