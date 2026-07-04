import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { flushSync } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { useViewMode } from '../context/ViewModeContext';
import { startDemoSession } from '../api';

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const { viewMode, setViewMode, isDeveloper } = useViewMode();
  const navigate = useNavigate();

  const handleViewSwitch = async (e) => {
    const mode = e.target.value;
    if (mode === 'demoStudent') {
      // Initialize demo session: creates/loads demo cohort, cycle, student, resets data
      await startDemoSession();
    }
    flushSync(() => setViewMode(mode));
    if (mode === 'admin') navigate('/admin/cohorts');
    else if (mode === 'student') navigate('/student/dashboard');
    else if (mode === 'demoStudent') navigate('/student/dashboard');
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          ZLP Scheduler<span style={{ display: 'inline', fontSize: 9, fontWeight: 700, fontStyle: 'italic', border: '1px solid rgba(255,255,255,0.55)', borderRadius: 3, padding: '1px 5px', marginLeft: 6, verticalAlign: 'top', letterSpacing: '0.06em', opacity: 0.75 }}>BETA</span>
          <span>{isDeveloper ? 'Developer Portal' : 'Admin Portal'}</span>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/admin/cohorts"><img src="/icon-cohorts.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) invert(1)', verticalAlign: 'middle', marginRight: 8 }} />Cohorts</NavLink>
          <NavLink to="/admin/join-code"><img src="/icon-join-code.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) invert(1)', verticalAlign: 'middle', marginRight: 8 }} />Join Code</NavLink>
          <NavLink to="/admin/students"><img src="/icon-students.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) invert(1)', verticalAlign: 'middle', marginRight: 8 }} />Cohort Members</NavLink>
          <NavLink to="/admin/algorithm"><img src="/icon-algorithm.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain', filter: 'brightness(0) invert(1)', verticalAlign: 'middle', marginRight: 8 }} />Algorithm</NavLink>
        </nav>
      </aside>
      <div className="main-content">
        <header className="top-header">
          <div className="user-info">
            Signed in as <strong>{user?.name}</strong>
          </div>
          {isDeveloper ? (
            <span className="cohort-tag dev-badge" style={{ borderRadius: 6 }}>Developer</span>
          ) : (
            <span className="cohort-tag" style={{ borderRadius: 6 }}>Admin</span>
          )}
          <div className="dev-view-switcher">
            <label htmlFor="view-switcher">View as:</label>
            <select id="view-switcher" value={viewMode} onChange={handleViewSwitch}>
              <option value="admin">Admin</option>
              {isDeveloper && <option value="student">Student (Dev)</option>}
              <option value="demoStudent">Demo Student</option>
            </select>
          </div>
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
