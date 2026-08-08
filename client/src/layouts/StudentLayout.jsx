import { useEffect } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { flushSync } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { useViewMode } from '../context/ViewModeContext';

export default function StudentLayout() {
  const { user, logout } = useAuth();
  const { viewMode, setViewMode, isDevUser, isDemoStudentMode } = useViewMode();
  const navigate = useNavigate();

  useEffect(() => { document.title = 'ZLP | Student'; }, []);

  const isAdmin = user?.role === 'admin' || user?.role === 'developer';

  const handleViewSwitch = (e) => {
    const mode = e.target.value;
    flushSync(() => setViewMode(mode));
    if (mode === 'admin') navigate('/admin/cohorts');
    else if (mode === 'demoStudent') navigate('/student/dashboard');
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          ZLP Scheduler<span style={{ display: 'inline', fontSize: 9, fontWeight: 700, fontStyle: 'italic', border: '1px solid rgba(255,255,255,0.55)', borderRadius: 3, padding: '1px 5px', marginLeft: 6, verticalAlign: 'top', letterSpacing: '0.06em', opacity: 0.75 }}>BETA</span>
          <span>Student Portal</span>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/student/dashboard">
            <img src="/icon-dashboard.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) invert(1)', verticalAlign: 'middle', marginRight: 8 }} />
            Dashboard
          </NavLink>
          <NavLink to="/student/search">
            <img src="/icon-search.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) invert(1)', verticalAlign: 'middle', marginRight: 8 }} />
            Course Search
          </NavLink>
          <NavLink to="/student/degree-planner">
            <img src="/icon-degree-planner.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) invert(1)', verticalAlign: 'middle', marginRight: 8 }} />
            Degree Planner
          </NavLink>
          <NavLink to="/student/flowchart">
            <img src="/icon-flowchart.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) invert(1)', verticalAlign: 'middle', marginRight: 8 }} />
            Degree Flowchart
          </NavLink>
        </nav>
      </aside>
      <div className="main-content">
        {isDevUser && viewMode === 'student' && (
          <div className="dev-banner">
            &#9888; Developer preview: you are viewing the student interface. Your admin role has not changed.
          </div>
        )}
        {isDemoStudentMode && (
          <div className="dev-banner demo-banner">
            &#x26A0; You are viewing the student portal as a demo account. No real student data is affected.
          </div>
        )}
        <header className="top-header">
          <div className="user-info">
            <strong>{user?.name}</strong>
          </div>
          {user?.cohortId && <span className="cohort-tag" style={{ background: '#dbeafe', color: '#1e40af', borderRadius: 6 }}>Student</span>}
          {isAdmin && (
            <div className="dev-view-switcher">
              <label htmlFor="view-switcher-s">View as:</label>
              <select id="view-switcher-s" value={viewMode} onChange={handleViewSwitch}>
                <option value="admin">Admin</option>
                {isDevUser && <option value="student">Student (Dev)</option>}
                <option value="demoStudent">Demo Student</option>
              </select>
            </div>
          )}
          <button
            onClick={logout}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '7px 16px', borderRadius: 999,
              background: '#fff', border: '2px solid #7f1d1d',
              color: '#7f1d1d', fontWeight: 600, fontSize: 14,
              cursor: 'pointer', lineHeight: 1,
            }}
          >
            <img src="/icon-logout.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) saturate(100%) invert(11%) sepia(63%) saturate(1200%) hue-rotate(330deg) brightness(80%)' }} />
            Logout
          </button>
        </header>
        <main className="page-body">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
