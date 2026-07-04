import { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';

const ViewModeContext = createContext(null);

const STORAGE_KEY = 'zlp_viewmode';

export function ViewModeProvider({ children }) {
  const { user } = useAuth();

  // Initialise synchronously from localStorage so the first render is correct.
  const [viewMode, setViewModeState] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'student' || stored === 'demoStudent') return stored;
    return 'admin';
  });

  // Once we know the user, validate/correct the stored mode.
  useEffect(() => {
    if (!user) return;

    if (user.role === 'student') {
      setViewModeState('student');
      localStorage.setItem(STORAGE_KEY, 'student');
      return;
    }

    if (user.role === 'admin') {
      const stored = localStorage.getItem(STORAGE_KEY);
      // Admins may be in demoStudent mode or admin mode
      if (stored === 'demoStudent') {
        setViewModeState('demoStudent');
      } else {
        setViewModeState('admin');
        localStorage.setItem(STORAGE_KEY, 'admin');
      }
      return;
    }

    // Developer — keep whatever is stored (or default to admin).
    if (user.isDeveloper) {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'student' || stored === 'demoStudent') {
        setViewModeState(stored);
      } else {
        setViewModeState('admin');
        localStorage.setItem(STORAGE_KEY, 'admin');
      }
      return;
    }

    // Fallback
    const correct = user.role === 'student' ? 'student' : 'admin';
    setViewModeState(correct);
    localStorage.setItem(STORAGE_KEY, correct);
  }, [user]);

  const setViewMode = (mode) => {
    setViewModeState(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  };

  return (
    <ViewModeContext.Provider
      value={{
        viewMode,
        setViewMode,
        isDevUser: !!user?.isDeveloper,
        isDeveloper: !!user?.isDeveloper,
        isDemoStudentMode: viewMode === 'demoStudent',
      }}
    >
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode() {
  return useContext(ViewModeContext);
}
