import { createBrowserRouter, createRoutesFromElements, RouterProvider, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ViewModeProvider } from './context/ViewModeContext';
import { RequireAdmin, RequireStudent, RequireGuest, RequireAuth } from './components/ProtectedRoute';

// Public pages
import LoginPage from './pages/LoginPage';
import JoinPage from './pages/JoinPage';
import JoinCohort from './pages/student/JoinCohort';
import AccessDeniedPage from './pages/AccessDeniedPage';

// Admin layout + pages
import AdminLayout from './layouts/AdminLayout';
import AdminCohorts from './pages/admin/AdminCohorts';
import AdminJoinCode from './pages/admin/AdminJoinCode';
import AdminStudents from './pages/admin/AdminStudents';
import AdminAlgorithm from './pages/admin/AdminAlgorithm';

// Student layout + pages
import StudentLayout from './layouts/StudentLayout';
import StudentDashboard from './pages/student/StudentDashboard';
import StudentSearch from './pages/student/StudentSearch';
import StudentDegreePlanner from './pages/student/StudentDegreePlanner';
import StudentFuturePlanning from './pages/student/StudentFuturePlanning';

function AppProviders() {
  return (
    <AuthProvider>
      <ViewModeProvider>
        <Outlet />
      </ViewModeProvider>
    </AuthProvider>
  );
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<AppProviders />}>
      {/* Public */}
      <Route path="/" element={<RequireGuest><LoginPage /></RequireGuest>} />
      <Route path="/join/:token" element={<JoinPage />} />
      <Route path="/join-cohort" element={<RequireAuth><JoinCohort /></RequireAuth>} />
      <Route path="/access-denied" element={<AccessDeniedPage />} />

      {/* Admin (accessible to admin + developer roles) */}
      <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
        <Route index element={<Navigate to="cohorts" replace />} />
        <Route path="cohorts" element={<AdminCohorts />} />
        <Route path="join-code" element={<AdminJoinCode />} />
        <Route path="students" element={<AdminStudents />} />
        <Route path="algorithm" element={<AdminAlgorithm />} />
        <Route path="run-algorithm" element={<AdminAlgorithm />} />
        <Route path="results" element={<AdminAlgorithm />} />
        <Route path="export" element={<AdminAlgorithm />} />
      </Route>

      {/* Student */}
      <Route path="/student" element={<RequireStudent><StudentLayout /></RequireStudent>}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<StudentDashboard />} />
        <Route path="search" element={<StudentSearch />} />
        <Route path="degree-planner" element={<StudentDegreePlanner />} />
        <Route path="flowchart" element={<StudentFuturePlanning />} />
        {/* Old path kept as a redirect so existing links/bookmarks still work. */}
        <Route path="future-planning" element={<Navigate to="/student/flowchart" replace />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  )
);

export default function App() {
  return <RouterProvider router={router} />;
}
