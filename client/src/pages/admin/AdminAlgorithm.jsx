import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getCohorts,
  getCyclesForCohort,
  runAlgorithm,
  getAlgorithmRuns,
  getAlgorithmRun,
  downloadAlgorithmRunUrl,
  getAlgorithmDebugInput,
} from '../../api';
import api from '../../api/client';
import CourseSectionsViewerModal from '../../components/CourseSectionsViewerModal';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAYS_DISPLAY = { M: 'M', T: 'T', W: 'W', R: 'R', F: 'F' };
const DAYS_ORDER   = ['M', 'T', 'W', 'R', 'F'];

// ---------------------------------------------------------------------------
// Helper: secondary-meeting-type badge
// ---------------------------------------------------------------------------
const SECONDARY_BADGE_TOOLTIPS = {
  'Lab only':             'The removed section options overlap through lab meetings only.',
  'Recitation only':      'The removed section options overlap through recitation meetings only.',
  'Lab/recitation only':  'The removed section options overlap through lab or recitation meetings only.',
  'Secondary only':       'The removed section options overlap through secondary meetings only.',
};
function SecondaryBadge({ item }) {
  const label = item.secondaryOnlyLabel ?? (item.labOnly ? 'Lab only' : null);
  if (!label) return null;
  return (
    <span
      title={SECONDARY_BADGE_TOOLTIPS[label] ?? `The removed section options overlap through ${label.toLowerCase()} meetings only.`}
      style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 8, padding: '2px 8px', borderRadius: 6, background: '#dbeafe', color: '#075985', fontSize: '0.85rem', fontWeight: 700, whiteSpace: 'nowrap', cursor: 'default' }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// RestrictedBadge — flags a conflict/blocked course where at least one affected
// student limited the course to a subset of sections by choice (when other
// sections existed). Signals the conflict is driven by the student's own
// preference, not an unavoidable scheduling clash.
// ---------------------------------------------------------------------------
function RestrictedBadge({ item }) {
  const names = item.restrictedStudentNames ?? [];
  if (names.length === 0) return null;
  const sections = item.restrictedStudentSections ?? [];
  const detail = sections.length > 0
    ? sections.map((r) => `${r.name} (${r.used ?? '?'} of ${r.total ?? '?'} sections)`).join(', ')
    : names.join(', ');
  return (
    <span
      title={`${detail} limited this course to a subset of sections by choice when other sections existed. The conflict is caused by their own preference, not an unavoidable clash.`}
      style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 8, padding: '2px 8px', borderRadius: 6, background: '#ede9fe', color: '#6d28d9', border: '1px solid #ddd6fe', fontSize: '0.8rem', fontWeight: 700, whiteSpace: 'nowrap', cursor: 'default' }}
    >
      ⓘ Student restricted sections
    </span>
  );
}

// ---------------------------------------------------------------------------
// StudentNamesWithRestriction — renders affected student names, marking the
// ones who narrowed the course to a subset of sections by choice.
// ---------------------------------------------------------------------------
function StudentNamesWithRestriction({ item }) {
  const restricted = new Set(item.restrictedStudentNames ?? []);
  const names = item.affectedStudentNames ?? [];
  return names.map((name, i) => (
    <span key={name}>
      {i > 0 ? ', ' : ''}
      {name}
      {restricted.has(name) && (
        <span title="Limited this course to a subset of sections by choice." style={{ color: '#6d28d9', fontWeight: 600 }}> (restricted)</span>
      )}
    </span>
  ));
}

// ---------------------------------------------------------------------------
// RestrictedStudentDetail — inline per-student narrowing detail shown inside a
// conflict/blocked card (Sections-Preferred): who narrowed the course, how many
// of their sections were used, and exactly which chosen sections clash.
// ---------------------------------------------------------------------------
function RestrictedStudentDetail({ item }) {
  const rows = item.restrictedStudentSections ?? [];
  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #ddd6fe' }}>
      {rows.map((r, i) => (
        <div key={i} style={{ fontSize: 12, color: '#6d28d9', marginTop: i > 0 ? 3 : 0 }}>
          <span style={{ fontWeight: 700 }}>{r.name}</span>
          {' '}restricted to {r.used ?? '?'} of {r.total ?? '?'} sections
          {r.chosen?.length > 0 && (
            <span style={{ color: '#9ca3af' }}> · chosen: {r.chosen.join(', ')}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section-highlight helpers — pull the section id out of "section (day time)"
// labels so the sections viewer can highlight the rows a restricted student's
// chosen sections map to.
// ---------------------------------------------------------------------------
function sectionIdsFromLabels(labels) {
  return Array.from(new Set(
    (labels ?? []).map((l) => String(l).split(' (')[0].trim()).filter(Boolean)
  ));
}

// Section ids a restricted student chose that clash with this window (direct
// conflict / blocked cards).
function conflictChosenSectionIds(item) {
  return sectionIdsFromLabels([
    ...(item.chosenSectionLabels ?? []),
    ...((item.restrictedStudentSections ?? []).flatMap((r) => r.chosen ?? [])),
  ]);
}

// ---------------------------------------------------------------------------
// Helper: format mode label
// ---------------------------------------------------------------------------
const MODE_ORDER = ['required_only', 'preferred', 'required_plus_preferred'];

function modeLabel(mode) {
  return mode === 'required_only' ? 'Required'
    : mode === 'preferred'        ? 'Preferred'
    : 'Sections-Preferred';
}

// Reserves the bold width so a tab label doesn't resize (and shift the layout)
// when it becomes active. A hidden bold copy holds the width; the visible copy
// overlaps it.
function TabLabel({ children }) {
  return (
    <span style={{ display: 'grid' }}>
      <span aria-hidden="true" style={{ gridColumn: 1, gridRow: 1, fontWeight: 700, visibility: 'hidden' }}>{children}</span>
      <span style={{ gridColumn: 1, gridRow: 1 }}>{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helper: compute heatmap cell colour (green → yellow → red)
// ---------------------------------------------------------------------------
function heatColour(value, max) {
  if (max === 0 || value === 0) return '#22c55e'; // green
  const ratio = Math.min(value / max, 1);
  if (ratio < 0.5) {
    const g = 255;
    const r = Math.round(ratio * 2 * 255);
    return `rgb(${r},${g},0)`;
  }
  const r = 255;
  const g = Math.round((1 - (ratio - 0.5) * 2) * 255);
  return `rgb(${r},${g},0)`;
}

// ---------------------------------------------------------------------------
// AlgorithmInfoPanel — collapsible "What the algorithm measures" help panel
// ---------------------------------------------------------------------------
function AlgorithmInfoPanel() {
  return (
    <div style={{ border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 8, overflow: 'hidden', position: 'sticky', top: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--color-bg-subtle, #f8f9fa)',
        padding: '10px 14px', borderBottom: '1px solid var(--color-border, #e5e7eb)',
      }}>
        <span style={{ fontSize: 13, background: '#e0e7ff', color: '#4338ca', borderRadius: '50%', width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontWeight: 700 }}>?</span>
        <strong style={{ fontSize: 13 }}>What the algorithm measures</strong>
      </div>
      <div style={{ padding: '14px 16px', fontSize: 12, lineHeight: 1.6 }}>
        <dl style={{ margin: 0 }}>
          {[
            ['Course Requests',             'Total submitted course requests included in the run. If two students request the same course, that counts as two course requests.'],
            ['Unique Courses',              'Number of distinct course codes included in the run. If multiple students request MEEN 364, it still counts as one unique course.'],
            ['Total Hard Conflicts',        'The main conflict score for a window. Equals Direct Conflict Requests plus Self-Conflict Students. Lower is better.'],
            ['Direct Conflict Requests',    'Course requests where every available section overlaps the ZLP window. The student cannot take that course if this window is selected.'],
            ['Conflict-Affected Students',  'Number of unique students with at least one direct conflict.'],
            ['Partially Blocked Requests',  'Course requests where some sections overlap the ZLP window, but at least one full section option remains available. These are not hard conflicts! The student can still take the course, but has fewer section options.'],
            ['Non-Lab/Rec Partially Blocked Req', 'Subset of Partially Blocked Requests where the blocking is NOT exclusively lab or recitation sections. A non-zero value means actual lecture sections are being cut, giving students fewer real scheduling options.'],
            ['Block-Affected Students',     'Number of unique students who lose at least one section option because of the ZLP window.'],
            ['Self-Conflict Students',      'Students who have at least one available section for each course individually, but cannot build a complete non-overlapping schedule from the remaining sections.'],
            ['Feasibility Unknown',         'Students whose schedule feasibility could not be fully verified by the solver. This usually means the solver reached a time or search limit.'],
            ['Best Window',                 'A candidate ZLP meeting time with the lowest score based on the ranking order.'],
            ['Required/Preferred/Sections-Preferred', 'Required: courses marked Required, all sections. Preferred: adds courses marked Preferred, still all sections open. Sections-Preferred: same courses, but narrowed to each student\'s chosen sections. Not Applied and Unclassified courses are excluded from all three.'],
            ['Preferred Sections',          'Only used in the Sections-Preferred tier, where preferred sections narrow the allowed section options for each student-course request. The Required and Preferred tiers leave all sections open.'],
            ['Sect.-Pref. Affected',      'Per window: how many students\' section preferences would be affected if that time were chosen. On Sections-Preferred it reflects the students actually restricted by their own section picks. Informational only on Required and Preferred, it does not affect the ranking.'],
            ['Section-Pref Students',       'Sections-Preferred tier only (summary card). The number of students who set a preferred section on at least one course.'],
            ['Courses w/ Section Pref',     'Sections-Preferred tier only (summary card). The number of unique courses that carry at least one student section preference.'],
          ].map(([term, def]) => (
            <div key={term} style={{ padding: '6px 0', borderBottom: '1px solid var(--color-border, #f3f4f6)' }}>
              <dt style={{ fontWeight: 600, color: '#374151', fontSize: 12, marginBottom: 2 }}>{term}</dt>
              <dd style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 12 }}>{def}</dd>
            </div>
          ))}
        </dl>
        <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--color-bg-subtle, #f8f9fa)', borderRadius: 6 }}>
          <strong style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>Ranking priority (lower = better):</strong>
          <ol style={{ margin: 0, padding: '0 0 0 18px', color: 'var(--color-text-muted)', fontSize: 12 }}>
            <li>Lowest Total Hard Conflicts</li>
            <li>Lowest Direct Conflict Requests</li>
            <li>Lowest Conflict-Affected Students</li>
            <li>Lowest Self-Conflict Students</li>
            <li>Lowest Non-Lab/Rec Partially Blocked Requests</li>
            <li>Lowest Partially Blocked Requests</li>
            <li>Lowest Block-Affected Students</li>
            <li>Lowest Feasibility Unknown Students</li>
            <li>Earlier start time</li>
            <li>Weekday order: M, T, W, R, F</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PreferredImpactCard — preferred hard-conflict summary for a Required Only window
// ---------------------------------------------------------------------------
function PreferredImpactCard({ impact }) {
  if (!impact) return (
    <div className="card" style={{ marginBottom: 20, padding: '14px 18px', borderLeft: '4px solid #e5e7eb' }}>
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>
        Preferred course data not available. Re-run in Required-Only mode to compute it.
      </p>
    </div>
  );

  const {
    preferredHardConflicts, preferredDirectConflictRequests, preferredSelfConflictStudents,
    preferredAffectedStudents, preferredFeasibilityUnknownStudents,
  } = impact;

  return (
    <div className="card" style={{ marginBottom: 20, borderLeft: `4px solid ${preferredHardConflicts === 0 ? '#86efac' : '#f59e0b'}` }}>
      <h4 style={{ margin: '0 0 4px', fontSize: 14, color: '#374151' }}>
        Preferred Course Check
      </h4>
      <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--color-text-muted)' }}>
        Extra check for the best Required-Only time
      </p>
      {preferredHardConflicts === 0 ? (
        <p style={{ color: '#16a34a', fontSize: 13, margin: '0 0 8px', fontWeight: 500 }}>
          ✓ Good news: this Required-Only time does not make any preferred courses impossible.
        </p>
      ) : (
        <>
          <p style={{ color: '#d97706', fontSize: 13, margin: '0 0 10px', fontWeight: 500 }}>
            ⚠ Warning: this Required-Only time would make some preferred courses impossible.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            {[
              { label: 'Students affected',    value: preferredAffectedStudents,           color: '#2563eb' },
              { label: 'Direct conflict',      value: preferredDirectConflictRequests,     color: '#dc2626' },
              { label: 'Self-conflict',        value: preferredSelfConflictStudents,       color: '#d97706' },
              ...(preferredFeasibilityUnknownStudents > 0
                ? [{ label: '\u26a0 Unknown', value: preferredFeasibilityUnknownStudents, color: '#b45309' }]
                : []),
            ].map(({ label, value, color }) => (
              <div key={label} style={{
                background: '#fffbeb', border: '1px solid #fde68a',
                borderRadius: 6, padding: '8px 14px', textAlign: 'center', minWidth: 90,
              }}>
                <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
                <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.3 }}>{label}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {preferredHardConflicts === 0 && (
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0' }}>
          This is informational only. Preferred courses do not affect the Required-Only ranking. Preferred blocked sections are ignored here because the course is still schedulable.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunSummaryCards  —  summary cards displayed after running / in results
// ---------------------------------------------------------------------------
function RunSummaryCards({ run }) {
  if (!run || run.status !== 'completed') return null;
  const { summary } = run;
  const legacyMode = run.parameters?.legacyMode ?? false;
  const checkFeasibility = !legacyMode; // self-conflict is ON unless legacy comparison mode was used
  const scoreColor = (v) => v === 0 ? '#16a34a' : v <= 3 ? '#d97706' : '#dc2626';
  const scoreBg    = (v) => v === 0 ? '#f0fdf4' : v <= 3 ? '#fffbeb' : '#fef2f2';
  // Sections-Preferred only: swap Students / Windows Evaluated for the two
  // section-preference metrics (students who set a preferred section; unique
  // courses carrying one).
  const isSectionsPreferred = run.mode === 'required_plus_preferred';
  const sectionPref = isSectionsPreferred ? (() => {
    const withPref = (run.results?.requestConstraintSummary ?? []).filter((r) => r.constraintMode === 'preferred');
    return {
      students: new Set(withPref.map((r) => r.studentName)).size,
      courses:  new Set(withPref.map((r) => r.courseCode)).size,
    };
  })() : null;
  const cardStudents = { label: 'Students',          value: summary.totalStudents,          scored: false };
  const cardRequests = { label: 'Course Requests',   value: summary.totalCourseRequests,    scored: false };
  const cardCourses  = { label: 'Unique Courses',    value: summary.totalUniqueCourses,     scored: false };
  const cardWindows  = { label: 'Windows Evaluated', value: summary.bestWindowsCount ?? '\u2014', scored: false };
  const cards = isSectionsPreferred
    ? [
        { label: 'Section-pref students',   value: sectionPref.students, scored: false },
        { label: 'Courses w/ section pref', value: sectionPref.courses,  scored: false },
        cardCourses,
        cardRequests,
      ]
    : [cardCourses, cardRequests, cardStudents, cardWindows];
  return (
    <div style={{ overflowX: 'auto', marginBottom: 20, borderBottom: '1px solid var(--color-border)', paddingBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, minWidth: 600 }}>
        {cards.map(({ label, value, scored }) => (
          <div
            key={label}
            style={{
              padding: '4px 0', textAlign: 'center',
              background: (scored && typeof value === 'number') ? scoreBg(value) : undefined,
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, color: (scored && typeof value === 'number') ? scoreColor(value) : undefined }}>{value}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeatmapGrid — browser heatmap of conflict counts
// ---------------------------------------------------------------------------
function HeatmapGrid({ heatmap, windows, onCellClick, selectedTime, selectedDay, checkFeasibility = false, onBackgroundClick }) {
  if (!heatmap || Object.keys(heatmap).length === 0) return null;

  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const startTimes = Object.keys(heatmap).sort((a, b) => toMin(a) - toMin(b));

  const maxConflict = Math.max(
    1,
    ...Object.values(heatmap).flatMap((dayMap) =>
      Object.values(dayMap).map((c) => c.totalHardConflicts ?? c.conflictRequests)
    )
  );

  return (
    <div style={{ overflowX: 'auto' }}>
      {/* table + a spacer strip to its right; only the spacer minimizes, so a
          misclick inside the grid never closes the card. */}
      <div style={{ display: 'flex', alignItems: 'stretch', width: 'max-content', minWidth: '100%' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: 'max-content' }}>
        <thead>
          <tr>
            <th style={{ padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap', width: 52, fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)' }}>START</th>
            {DAYS_ORDER.map((d) => (
              <th key={d} style={{ padding: '4px 0', textAlign: 'center', width: 56 }}>
                {DAYS_DISPLAY[d]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {startTimes.map((st) => (
            <tr key={st}>
              <td style={{ padding: '2px 8px', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'right', width: 52 }}>
                {st}
              </td>
              {DAYS_ORDER.map((day) => {
                const cell = heatmap[st]?.[day];
                const isSelected = selectedTime === st && selectedDay === day;
                if (!cell) {
                  return (
                    <td key={day} style={{ padding: '2px 4px', textAlign: 'center' }}>
                      <div style={{ width: 48, height: 22, borderRadius: 4, background: '#f0f0f0', margin: '0 auto' }} />
                    </td>
                  );
                }
                const bg = heatColour(cell.totalHardConflicts ?? cell.conflictRequests, maxConflict);
                const hasUnknown = checkFeasibility && (cell.feasibilityUnknownCount ?? 0) > 0;
                return (
                  <td key={day} style={{ padding: '2px 4px', textAlign: 'center' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); onCellClick && onCellClick(st, day); }}
                      title={`${DAYS_DISPLAY[day]} ${st}: ${cell.totalHardConflicts ?? cell.conflictRequests} total hard conflicts (${cell.conflictRequests} direct${cell.selfConflictStudents != null ? ` + ${cell.selfConflictStudents} self-conflict` : ''}), rank #${cell.rank}${hasUnknown ? ` (⚠ ${cell.feasibilityUnknownCount} unknown)` : ''}`}
                      style={{
                        width: 48,
                        height: 22,
                        borderRadius: 4,
                        background: bg,
                        border: isSelected
                          ? '2px solid #3b82f6'
                          : hasUnknown
                          ? '2px solid #f59e0b'
                          : '1px solid rgba(0,0,0,.1)',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#000',
                        fontWeight: 600,
                        fontSize: 10,
                        padding: 0,
                        margin: 0,
                        position: 'relative',
                      }}
                    >
                      {cell.totalHardConflicts ?? cell.conflictRequests}
                      {hasUnknown && (
                        <span style={{
                          position: 'absolute', top: -4, right: -4,
                          background: '#f59e0b', color: '#fff',
                          borderRadius: '50%', width: 12, height: 12,
                          fontSize: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 700, lineHeight: 1, pointerEvents: 'none',
                        }}>?</span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
        {onBackgroundClick && (
          <div
            onClick={onBackgroundClick}
            title="Click to minimize"
            style={{ flex: 1, minWidth: 24, marginLeft: 32, cursor: 'pointer' }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WindowDetailModal — popup when a heatmap cell or window row is clicked
// ---------------------------------------------------------------------------
function WindowDetailModal({ win, onClose, cohortId, cycleId, termCode = null, checkFeasibility = true, runMode = 'required_only' }) {
  useEffect(() => {
    if (!win) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [win, onClose]);

  const [debugData,         setDebugData]         = useState(null);
  const [debugLoading,      setDebugLoading]      = useState(false);
  const [debugError,        setDebugError]        = useState('');
  const [debugOpen,         setDebugOpen]         = useState(false);
  const [hideSecondaryOnly, setHideSecondaryOnly] = useState(false);
  const [hideSectionChoice, setHideSectionChoice] = useState(false);
  // Course code whose sections are being viewed in the read-only section popup.
  const [viewCourse, setViewCourse] = useState(null);

  if (!win) return null;

  // Backward-compatible field names (new runs use selfConflict*, old may use selfBlocked*)
  const selfConflictStudents     = win.selfConflictStudents     ?? win.selfBlockedStudents     ?? 0;
  const selfConflictStudentNames = win.selfConflictStudentNames ?? win.selfBlockedStudentNames ?? [];
  const selfConflictReasons      = win.selfConflictReasons      ?? win.selfBlockReasons        ?? [];
  const feasibilityUnknownCount  = win.feasibilityUnknownCount  ?? win.feasibilityUnknownStudents?.length ?? 0;
  const totalHardConflicts       = win.totalHardConflicts       ?? (win.conflictRequests + selfConflictStudents);

  const classColor = (cls) =>
    cls === 'required' ? '#16a34a' : cls === 'preferred' ? '#d97706' : '#6b7280';

  // Preferred tier shows a section-preference-only check (the narrowing delta);
  // Required shows the full preferred impact. Sections-Preferred shows the
  // restricted detail inline in its red/blocked cards instead of a bottom panel.
  const isSectionPrefView = runMode === 'preferred';
  const prefImpact = win.preferredHardConflictImpact;
  const narrowingOnlyImpacted = (prefImpact?.impactedStudents ?? [])
    .map((s) => ({ ...s, impacts: s.impacts.filter((i) => i.narrowedByChoice) }))
    .filter((s) => s.impacts.length > 0);
  const prefNothingToShow = isSectionPrefView
    ? (prefImpact?.preferredRestrictedStudents ?? 0) === 0
    : prefImpact?.preferredHardConflicts === 0;

  function handleDebug(mode) {
    if (!cohortId || !cycleId) return;
    setDebugLoading(true);
    setDebugError('');
    setDebugData(null);
    setDebugOpen(true);
    api.post('/api/admin/algorithm/window-debug', {
      cohortId,
      schedulingCycleId: cycleId,
      mode: mode ?? 'required_only',
      day: win.day,
      startMinutes: win.startMinutes,
    })
      .then((res) => setDebugData(res.data))
      .catch((e) => setDebugError(e?.response?.data?.error ?? e.message ?? 'Debug failed.'))
      .finally(() => setDebugLoading(false));
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 60, paddingBottom: 24,
        overflowY: 'auto',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#fff', borderRadius: 10, padding: '20px 24px',
          maxWidth: 680, width: '100%', boxShadow: '0 8px 40px rgba(0,0,0,.2)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 12, right: 14, background: 'none',
            border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280', lineHeight: 1,
          }}
          title="Close"
        >
          &times;
        </button>

        {/* Window header */}
        <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Window Detail</h3>
        <div style={{ fontSize: 13, marginBottom: 16, color: '#374151', whiteSpace: 'nowrap' }}>
          <strong>Day:</strong>&nbsp;{win.dayLabel ?? win.day}&ensp;&bull;&ensp;
          <strong>Start:</strong>&nbsp;{win.startTime}&ensp;&bull;&ensp;
          <strong>End:</strong>&nbsp;{win.endTime}&ensp;&bull;&ensp;
          <strong>Rank:</strong>&nbsp;#{win.rank}
        </div>

        {/* Feasibility Unknown — prominent alert when present */}
        {feasibilityUnknownCount > 0 && (
          <div style={{
            marginBottom: 16, padding: '10px 14px',
            background: '#fffbeb', border: '2px solid #f59e0b', borderRadius: 8,
          }}>
            <div style={{ fontWeight: 700, color: '#92400e', fontSize: 13, marginBottom: 4 }}>
              ⚠ Feasibility Unknown — {feasibilityUnknownCount} student{feasibilityUnknownCount !== 1 ? 's' : ''}
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#78350f' }}>
              Schedule-combination search limit was reached for{' '}
              {win.feasibilityUnknownStudents?.join(', ') ?? `${feasibilityUnknownCount} student(s)`}.
              The direct conflict and blocked-course counts above are accurate.
              Full self-conflict feasibility (whether the remaining sections can form a valid schedule)
              could not be proven within the search limit.
              This window is ranked below fully-verified windows with the same conflict score.
            </p>
          </div>
        )}

        {/* Score summary chips */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          {[
            { label: 'Total Hard Conflicts', value: totalHardConflicts, color: totalHardConflicts > 0 ? '#ef4444' : '#16a34a' },
            { label: 'Direct Conflict Requests', value: win.conflictRequests, color: win.conflictRequests > 0 ? '#dc2626' : '#6b7280' },
            { label: 'Self-Conflict Students', value: selfConflictStudents,  color: selfConflictStudents > 0 ? '#ef4444' : '#6b7280' },
            { label: 'Conflict-Affected Students', value: win.affectedStudents, color: '#2563eb' },
            { label: 'Non-Lab Partially Blocked', value: win.nonLabBlockedRequests ?? 0, color: '#6b7280', title: 'Partially blocked requests where actual lecture sections overlap the ZLP time — not just labs or recitations.' },
            { label: 'Partially Blocked Requests', value: win.blockedRequests, color: '#6b7280', title: 'Some section options overlap this ZLP time. At least one full section option still works. These are not hard conflicts.' },
            { label: 'Feasibility Unknown', value: feasibilityUnknownCount,
              color: feasibilityUnknownCount > 0 ? '#b45309' : '#6b7280',
              bg: feasibilityUnknownCount > 0 ? '#fffbeb' : '#f9fafb',
              border: feasibilityUnknownCount > 0 ? '#fcd34d' : '#e5e7eb' },
          ].map(({ label, value, color, bg, border, title }) => (
            <div key={label} title={title} style={{
              background: bg ?? '#f9fafb',
              border: `1px solid ${border ?? '#e5e7eb'}`,
              borderRadius: 6, padding: '6px 12px', textAlign: 'center', minWidth: 80,
            }}>
              <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
              <div style={{ fontSize: 10, color: '#6b7280' }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Solver Status Breakdown — developer only, removed from admin view */}
        {false && win.feasibilitySolverCounts && (
          <details style={{ marginBottom: 16, fontSize: 12, color: '#6b7280' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#374151' }}>
              Solver Status Breakdown (required students)
            </summary>
            <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { label: 'Feasible (exact)',    value: win.feasibilitySolverCounts.feasible_exact,      color: '#16a34a' },
                { label: 'Self-conflict',        value: win.feasibilitySolverCounts.self_conflict_exact, color: '#d97706' },
                { label: 'Skipped (low-risk)',   value: win.feasibilitySolverCounts.skipped_low_risk,    color: '#6b7280' },
                { label: '⚠ Timeout (unknown)', value: win.feasibilitySolverCounts.unknown_timeout,     color: win.feasibilitySolverCounts.unknown_timeout > 0 ? '#b45309' : '#6b7280' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', textAlign: 'center', minWidth: 70 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
                  <div style={{ fontSize: 10, color: '#6b7280' }}>{label}</div>
                </div>
              ))}
            </div>
            {win.unknownTimeoutDetails?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600, color: '#92400e', marginBottom: 4 }}>Timeout details:</div>
                <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                  <thead>
                    <tr style={{ background: '#fffbeb' }}>
                      {['Student', 'Nodes checked', 'Node limit', 'Constrained courses'].map((h) => (
                        <th key={h} style={{ padding: '2px 8px', textAlign: 'left', borderBottom: '1px solid #fcd34d' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {win.unknownTimeoutDetails.map((d, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '2px 8px' }}>{d.studentName}</td>
                        <td style={{ padding: '2px 8px' }}>{d.searchNodes}</td>
                        <td style={{ padding: '2px 8px' }}>{d.searchLimit}</td>
                        <td style={{ padding: '2px 8px' }}>{d.constrainedCourses.map((c) => `${c.code} (${c.primaryGroupsAfterZlp} grp)`).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {/* Preferred path counts (required_only mode) */}
            {win.preferredHardConflictImpact?.prefFeasibilitySolverCounts && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>Solver Status Breakdown (preferred students)</div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Feasible (exact)',    value: win.preferredHardConflictImpact.prefFeasibilitySolverCounts.feasible_exact,      color: '#16a34a' },
                    { label: 'Self-conflict',        value: win.preferredHardConflictImpact.prefFeasibilitySolverCounts.self_conflict_exact, color: '#d97706' },
                    { label: 'Skipped (low-risk)',   value: win.preferredHardConflictImpact.prefFeasibilitySolverCounts.skipped_low_risk,    color: '#6b7280' },
                    { label: '⚠ Timeout (unknown)', value: win.preferredHardConflictImpact.prefFeasibilitySolverCounts.unknown_timeout,     color: win.preferredHardConflictImpact.prefFeasibilitySolverCounts.unknown_timeout > 0 ? '#b45309' : '#6b7280' },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', textAlign: 'center', minWidth: 70 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
                      <div style={{ fontSize: 10, color: '#6b7280' }}>{label}</div>
                    </div>
                  ))}
                </div>
                {win.preferredHardConflictImpact.prefUnknownTimeoutDetails?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 600, color: '#92400e', marginBottom: 4 }}>Preferred timeout details:</div>
                    <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                      <thead>
                        <tr style={{ background: '#fffbeb' }}>
                          {['Student', 'Nodes checked', 'Node limit', 'Constrained courses'].map((h) => (
                            <th key={h} style={{ padding: '2px 8px', textAlign: 'left', borderBottom: '1px solid #fcd34d' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {win.preferredHardConflictImpact.prefUnknownTimeoutDetails.map((d, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '2px 8px' }}>{d.studentName}</td>
                            <td style={{ padding: '2px 8px' }}>{d.searchNodes}</td>
                            <td style={{ padding: '2px 8px' }}>{d.searchLimit}</td>
                            <td style={{ padding: '2px 8px' }}>{d.constrainedCourses.map((c) => `${c.code} (${c.primaryGroupsAfterZlp} grp)`).join(', ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </details>
        )}

        {/* Direct Conflicts */}
        <section style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 14, color: win.conflictCourses?.length > 0 ? '#dc2626' : '#16a34a' }}>
            {win.conflictCourses?.length > 0
              ? `Direct Conflicts (${win.conflictCourses.length})`
              : 'No Direct Conflicts'}
          </h4>
          {win.conflictCourses?.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {win.conflictCourses.map((c) => (
                <div key={c.code}
                  onClick={() => setViewCourse({ code: c.code, title: c.title, highlightSections: conflictChosenSectionIds(c), isPreferred: c.classification === 'preferred' })}
                  title="View sections & times"
                  style={{
                    background: '#fef2f2', border: '1px solid #fecaca',
                    borderRadius: 6, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                  }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>
                    {c.code}
                    {c.title && <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>— {c.title}</span>}
                    <SecondaryBadge item={c} />
                    <RestrictedBadge item={c} />
                  </div>
                  <div style={{ fontSize: 12, color: '#374151' }}>
                    <span style={{ color: classColor(c.classification), fontWeight: 600 }}>{c.classification}</span>
                    {' \u00b7 '}
                    {c.requestCount} {c.requestCount === 1 ? 'student' : 'students'}
                    {c.affectedStudentNames?.length > 0 && (
                      <span style={{ color: '#4b5563', marginLeft: 4 }}>
                        (<StudentNamesWithRestriction item={c} />)
                      </span>
                    )}
                  </div>
                  <RestrictedStudentDetail item={c} />
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: '#16a34a', margin: 0 }}>
              No courses have all sections conflicting with this window.
            </p>
          )}
        </section>

        {/* Self-Conflict Students — before blocked courses */}
        {selfConflictStudentNames.length > 0 && (
          <section style={{ marginBottom: 16 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#dc2626' }}>
              Self-Conflict Students ({selfConflictStudentNames.length})
            </h4>
            <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>
              These students still have section options for each course, but the remaining options do not fit together into one complete schedule.
            </p>
            <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: 13 }}>
              {selfConflictStudentNames.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </section>
        )}

        {/* Blocked Courses */}
        {win.blockedCourses?.length > 0 && (() => {
          const secondaryOnlyCount = win.blockedCourses.filter((c) => c.labOnly || c.secondaryOnlyLabel).length;
          const visibleCourses = hideSecondaryOnly
            ? win.blockedCourses.filter((c) => !c.labOnly && !c.secondaryOnlyLabel)
            : win.blockedCourses;
          return (
            <section style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                <h4 style={{ margin: 0, fontSize: 14, color: '#d97706' }}>
                  Partially Blocked Courses ({hideSecondaryOnly ? `${visibleCourses.length} of ${win.blockedCourses.length}` : win.blockedCourses.length})
                </h4>
                {secondaryOnlyCount > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#6b7280', cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={hideSecondaryOnly}
                      onChange={(e) => setHideSecondaryOnly(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    Hide lab/rec-only ({secondaryOnlyCount})
                  </label>
                )}
              </div>
              <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>
                Some section options overlap this ZLP time, but at least one full section option still works. These are not hard conflicts. The student can still take the course, but has fewer section choices.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visibleCourses.map((c) => (
                  <div key={c.code}
                    onClick={() => setViewCourse({ code: c.code, title: c.title, highlightSections: conflictChosenSectionIds(c), isPreferred: c.classification === 'preferred' })}
                    title="View sections & times"
                    style={{
                      background: '#fffbeb', border: '1px solid #fde68a',
                      borderRadius: 6, padding: '7px 12px', fontSize: 13, cursor: 'pointer',
                    }}>
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      {c.code}
                      {c.title && <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>— {c.title}</span>}
                      <SecondaryBadge item={c} />
                      <RestrictedBadge item={c} />
                      {Number.isFinite(c.totalSections) && c.totalSections > 0 && (
                        <span
                          title={hideSecondaryOnly
                            ? 'Sections blocked by a lecture-time overlap, out of the total available. Most-impacted student shown.'
                            : 'Sections of this course that overlap the ZLP window, out of the total available. Most-impacted student shown.'}
                          style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 6, fontSize: 12 }}
                        >
                          ({hideSecondaryOnly ? (c.lectureBlockedSections ?? c.blockedSections) : c.blockedSections}/{c.totalSections} {hideSecondaryOnly ? 'lecture sections' : 'sections'} blocked)
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#374151' }}>
                      <span style={{ color: classColor(c.classification), fontWeight: 600 }}>{c.classification}</span>
                      {' \u00b7 '}
                      {c.requestCount} {c.requestCount === 1 ? 'student' : 'students'}
                      {c.affectedStudentNames?.length > 0 && (
                        <span style={{ color: '#4b5563', marginLeft: 4 }}>
                          (<StudentNamesWithRestriction item={c} />)
                        </span>
                      )}
                    </div>
                    <RestrictedStudentDetail item={c} />
                  </div>
                ))}
                {hideSecondaryOnly && visibleCourses.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6b7280', margin: 0, fontStyle: 'italic' }}>
                    All partially blocked courses are lab/recitation-only.
                  </p>
                )}
              </div>
            </section>
          );
        })()}

        {/* Preferred Course Check (Required tier) / Section-Preference Check (Preferred tier) */}
        {win.preferredHardConflictImpact && (
          <section style={{ marginBottom: 16 }}>
            <h4 style={{ margin: '0 0 2px', fontSize: 14, color: '#374151' }}>
              {isSectionPrefView ? 'Section-Preference Check' : 'Preferred Course Check'}
            </h4>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: '#9ca3af' }}>
              {isSectionPrefView
                ? 'Informational only — does not affect the ranking. Shows students whose chosen sections would all be blocked here if section preferences were honored (the Sections-Preferred tier).'
                : 'Additional check for this Required-Only time. This is informational and does not affect the ranking.'}
            </p>
            {prefNothingToShow ? (
              <p style={{ fontSize: 13, color: '#16a34a', margin: 0, fontWeight: 500 }}>
                {isSectionPrefView
                  ? '✓ Good news: no student’s chosen sections are all blocked by this time.'
                  : '✓ Good news: this Required-Only time does not make any preferred courses impossible.'}
              </p>
            ) : (
              <>
                <p style={{ fontSize: 13, color: '#d97706', margin: '0 0 10px', fontWeight: 500 }}>
                  {isSectionPrefView
                    ? '⚠ Note: some students narrowed their sections to ones that all conflict with this time.'
                    : (win.preferredHardConflictImpact.preferredGenuineImpossibleCourses ?? win.preferredHardConflictImpact.preferredHardConflicts) > 0
                      ? '⚠ Warning: this Required-Only time would make some preferred courses impossible.'
                      : '⚠ Note: no preferred course is impossible on its own here. But, some students restricted their sections to ones that all conflict with this time.'}
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {(isSectionPrefView ? [
                    { label: 'Students affected', value: win.preferredHardConflictImpact.preferredRestrictedStudents ?? 0, color: '#6d28d9', always: true },
                  ] : [
                    { label: 'Students affected',  value: win.preferredHardConflictImpact.preferredAffectedStudents, color: '#2563eb', always: true },
                    { label: 'Impossible courses', value: win.preferredHardConflictImpact.preferredGenuineImpossibleCourses ?? win.preferredHardConflictImpact.preferredHardConflicts, color: '#d97706', always: true },
                    { label: 'Direct conflict',    value: win.preferredHardConflictImpact.preferredGenuineDirectConflicts ?? win.preferredHardConflictImpact.preferredDirectConflictRequests, color: '#dc2626', always: true },
                    { label: 'Self-conflict',      value: win.preferredHardConflictImpact.preferredSelfConflictStudents, color: '#d97706' },
                    { label: '\u26a0 Unknown',     value: win.preferredHardConflictImpact.preferredFeasibilityUnknownStudents, color: '#b45309' },
                    // Last + lowest priority: students whose impossibility is their own
                    // section narrowing (course still schedulable on all sections).
                    { label: 'Restricted students', value: win.preferredHardConflictImpact.preferredRestrictedStudents ?? 0, color: '#6d28d9', always: true, title: 'Number of students (not courses) whose preferred course is only impossible because they narrowed it to specific sections that all conflict. The course itself is still schedulable on all sections.' },
                  ]).filter(({ value, always }) => always || value > 0).map(({ label, value, color, title }) => (
                    <div key={label} title={title} style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '5px 10px', textAlign: 'center', minWidth: 80 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
                      <div style={{ fontSize: 10, color: '#6b7280' }}>{label}</div>
                    </div>
                  ))}
                </div>
                {(isSectionPrefView ? narrowingOnlyImpacted : win.preferredHardConflictImpact.impactedStudents)?.length > 0 && (() => {
                  const allImpacted = isSectionPrefView ? narrowingOnlyImpacted : win.preferredHardConflictImpact.impactedStudents;
                  // Students whose impossible-course conflict is caused (at least
                  // partly) by their own section choice (narrowing).
                  const sectionChoiceCount = allImpacted.filter((s) => s.impacts.some((i) => i.narrowedByChoice)).length;
                  // Required tier can hide section-choice conflicts; the Preferred
                  // tier already shows only those, so no toggle.
                  const visibleImpacted = (!isSectionPrefView && hideSectionChoice)
                    ? allImpacted
                        .map((s) => ({ ...s, impacts: s.impacts.filter((i) => !i.narrowedByChoice) }))
                        .filter((s) => s.impacts.length > 0)
                    : allImpacted;
                  return (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
                        {isSectionPrefView
                          ? `Students with all chosen sections blocked (${allImpacted.length})`
                          : `Students with impossible preferred courses (${hideSectionChoice ? `${visibleImpacted.length} of ${allImpacted.length}` : allImpacted.length})`}
                      </div>
                      {!isSectionPrefView && sectionChoiceCount > 0 && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#6b7280', cursor: 'pointer', userSelect: 'none' }}>
                          <input
                            type="checkbox"
                            checked={hideSectionChoice}
                            onChange={(e) => setHideSectionChoice(e.target.checked)}
                            style={{ cursor: 'pointer' }}
                          />
                          Hide section-choice conflicts ({sectionChoiceCount})
                        </label>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      {visibleImpacted.map((s) => {
                        // Student-level flag: did this student restrict the course to a
                        // subset of sections (when others existed) on any conflict? If so,
                        // the conflict is driven by their own choice, not unavoidable.
                        const restricted = s.impacts.some((i) => i.narrowedByChoice);
                        // First conflicting course that has a code — clicking anywhere in
                        // the box opens its sections (self-conflict/unknown impacts have none).
                        const boxCourse = s.impacts.find((i) => i.courseCode);
                        return (
                        <div key={s.studentEmail ?? s.studentName}
                          onClick={boxCourse ? () => setViewCourse({ code: boxCourse.courseCode, title: boxCourse.courseTitle, highlightSections: sectionIdsFromLabels(boxCourse.overlappingSectionLabels), isPreferred: boxCourse.classification === 'preferred' }) : undefined}
                          title={boxCourse ? 'View sections & times' : undefined}
                          style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 12px', cursor: boxCourse ? 'pointer' : undefined }}>
                          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                            {s.studentName}
                            {restricted ? (
                              <>
                                <span
                                  title="This student limited this course to a subset of sections by choice when other sections existed. The conflict is caused by their own preference, not an unavoidable scheduling clash."
                                  style={{
                                    fontWeight: 600, color: '#6d28d9', background: '#ede9fe', border: '1px solid #ddd6fe',
                                    fontSize: 11, borderRadius: 3, padding: '1px 6px',
                                  }}
                                >
                                  ⓘ Student restricted sections
                                </span>
                                {s.impacts.filter((i) => i.narrowedByChoice).map((i, ix) => (
                                  <span
                                    key={ix}
                                    title={`${i.courseCode}: narrowed to ${i.preferredSectionsUsed} of ${i.totalSectionsAvailable} sections`}
                                    style={{
                                      fontWeight: 600, color: '#6d28d9', background: '#ffffff', border: '1px solid #ddd6fe',
                                      fontSize: 11, borderRadius: 3, padding: '1px 6px',
                                    }}
                                  >
                                    {i.preferredSectionsUsed} of {i.totalSectionsAvailable} sections
                                  </span>
                                ))}
                              </>
                            ) : null}
                          </div>
                          {s.impacts.map((impact, i) => (
                            <div key={i}
                              onClick={impact.courseCode ? (e) => { e.stopPropagation(); setViewCourse({ code: impact.courseCode, title: impact.courseTitle, highlightSections: sectionIdsFromLabels(impact.overlappingSectionLabels), isPreferred: impact.classification === 'preferred' }); } : undefined}
                              style={{ fontSize: 12, color: '#374151', marginBottom: 6, cursor: impact.courseCode ? 'pointer' : undefined }}>
                              {/* Line 1: badge · classification · course — title */}
                              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                                {(() => {
                                  // A narrowed-by-choice direct conflict is NOT a genuine
                                  // direct conflict (the course is still schedulable on all
                                  // sections). It's counted under "Restricted students", not
                                  // "Direct conflict" — so badge it as a section-choice
                                  // conflict (violet) to match, rather than red "Direct conflict".
                                  const isGenuineDirect = impact.impactType === 'preferred_direct_conflict' && !impact.narrowedByChoice;
                                  const isSectionChoice = impact.impactType === 'preferred_direct_conflict' && impact.narrowedByChoice;
                                  const isSelf          = impact.impactType === 'preferred_self_conflict';
                                  const bg    = isGenuineDirect ? '#fee2e2' : isSectionChoice ? '#ede9fe' : isSelf ? '#fef9c3' : '#f3f4f6';
                                  const color = isGenuineDirect ? '#dc2626' : isSectionChoice ? '#6d28d9' : isSelf ? '#d97706' : '#6b7280';
                                  const text  = isGenuineDirect ? 'Direct conflict' : isSectionChoice ? 'Section conflict' : isSelf ? 'Self-conflict' : 'Unknown';
                                  return (
                                    <span style={{ background: bg, color, borderRadius: 3, padding: '1px 6px', fontSize: 10 }}>{text}</span>
                                  );
                                })()}
                                {impact.classification && (
                                  <span
                                    title={impact.classification === 'required'
                                      ? 'This is a required course (runs all sections in the main algorithm). It appears here because the student narrowed it to specific sections.'
                                      : undefined}
                                    style={{ color: classColor(impact.classification), fontWeight: 600, fontSize: 11, textTransform: 'capitalize' }}
                                  >
                                    {impact.classification}
                                  </span>
                                )}
                                {impact.courseCode && (
                                  <span style={{ fontWeight: 600 }}>
                                    {impact.courseCode}{impact.courseTitle ? ` — ${impact.courseTitle}` : ''}
                                  </span>
                                )}
                                <SecondaryBadge item={impact} />
                              </div>
                              {/* Line 2: reason */}
                              <div style={{ color: '#6b7280', marginTop: 2 }}>{impact.reason}</div>
                              {/* Line 3: chosen sections */}
                              {impact.overlappingSectionLabels?.length > 0 && (
                                <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
                                  chosen: {impact.overlappingSectionLabels.join(', ')}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        );
                      })}
                    </div>
                    {hideSectionChoice && visibleImpacted.length === 0 && (
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0', fontStyle: 'italic' }}>
                        Every impossible preferred course here is caused by a student&apos;s own section choice. None are impossible on their own.
                      </p>
                    )}
                  </div>
                  );
                })()}
              </>
            )}
            {prefNothingToShow && (
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0' }}>
                {isSectionPrefView
                  ? 'Informational only. All sections stay open in the Preferred tier; this shows what the Sections-Preferred tier would block.'
                  : 'This is informational only. Preferred courses do not affect the Required-Only ranking. Preferred blocked sections are ignored here because the course is still schedulable.'}
              </p>
            )}
          </section>
        )}

        {/* Feasibility warnings (data warnings) */}
        {win.feasibilityWarnings?.filter((w) => !w.startsWith('Feasibility unknown')).length > 0 && (
          <details style={{ marginBottom: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
              Data Warnings ({win.feasibilityWarnings.filter((w) => !w.startsWith('Feasibility unknown')).length})
            </summary>
            <ul style={{ margin: '6px 0 0', padding: '0 0 0 18px', fontSize: 12, color: '#6b7280' }}>
              {win.feasibilityWarnings
                .filter((w) => !w.startsWith('Feasibility unknown'))
                .slice(0, 10)
                .map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </details>
        )}

        {/* Window Debug Panel — developer only, removed from admin view */}
        {false && cohortId && cycleId && (
          <details open={debugOpen} onToggle={(e) => { if (!e.currentTarget.open) { setDebugOpen(false); setDebugData(null); } }}>
            <summary
              style={{ cursor: 'pointer', fontSize: 12, color: '#4b5563', fontWeight: 600, marginBottom: 8 }}
              onClick={(e) => { e.preventDefault(); if (!debugOpen) handleDebug(runMode); else { setDebugOpen(false); setDebugData(null); } }}
            >
              🔍 Per-Student Schedule Debug
            </summary>
            {debugLoading && <p style={{ fontSize: 12, color: '#6b7280' }}>Loading debug data…</p>}
            {debugError  && <p style={{ fontSize: 12, color: '#ef4444' }}>{debugError}</p>}
            {debugData && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <div style={{ marginBottom: 8, color: '#6b7280' }}>
                  Mode: {debugData.mode} · Term: {debugData.termCode} ·{' '}
                  {debugData.studentCount} student{debugData.studentCount !== 1 ? 's' : ''}
                  {' '}evaluated for {debugData.window.startTime}–{debugData.window.endTime} {debugData.window.day}
                </div>
                {debugData.studentDebug.map((s) => {
                  const statusColor =
                    s.selfConflictStatus === 'self_conflict_exact' ? '#b45309' :
                    s.selfConflictStatus === 'unknown_timeout'     ? '#92400e' :
                    s.selfConflictStatus === 'skipped_low_risk'    ? '#6b7280' :
                    s.directConflicts.length > 0                   ? '#dc2626' : '#16a34a';
                  const statusIcon =
                    s.selfConflictStatus === 'self_conflict_exact' ? '⛔ Self-conflict' :
                    s.selfConflictStatus === 'unknown_timeout'     ? `⚠ Unknown — solver limit (${s.searchNodesChecked}/${s.searchLimit} nodes)` :
                    s.selfConflictStatus === 'skipped_low_risk'    ? '◌ Low-risk — heuristic skip' :
                    s.directConflicts.length > 0                   ? `⛔ ${s.directConflicts.length} direct conflict(s)` :
                                                                     '✓ Feasible — checked';
                  return (
                    <details key={s.studentId} style={{ marginBottom: 8, border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px' }}>
                      <summary style={{ cursor: 'pointer', fontWeight: 600, color: statusColor }}>
                        {s.studentName}{' — '}{statusIcon}
                      </summary>
                      <div style={{ marginTop: 6 }}>
                        <div style={{ marginBottom: 6, color: '#4b5563', fontStyle: s.selfConflictStatus === 'skipped_low_risk' ? 'italic' : 'normal' }}>
                          {s.reason}
                        </div>
                        {s.selfConflictStatus === 'skipped_low_risk' && (
                          <div style={{ marginBottom: 6, fontSize: 11, color: '#9ca3af', background: '#f9fafb', borderRadius: 4, padding: '4px 8px' }}>
                            Heuristic: self-conflict was not checked. This student is treated as acceptable for window scoring.
                          </div>
                        )}
                        <div style={{ marginBottom: 4 }}>
                          <strong>Direct conflicts:</strong> {s.directConflicts.length > 0 ? s.directConflicts.join(', ') : 'none'}&ensp;
                          <strong>Partially blocked:</strong> {s.blockedCourses.length > 0 ? s.blockedCourses.join(', ') : 'none'}&ensp;
                          <strong>Courses checked:</strong> {s.dfsCourseCount ?? s.survivingCoursesForCheck?.length ?? 0}&ensp;
                          {s.constrainedCourses?.length > 0 && (
                            <><strong>Constrained:</strong> {s.constrainedCourses.map((c) => `${c.code} (${c.primaryGroupsAfterZlp} grp)`).join(', ')}&ensp;</>
                          )}
                        </div>
                        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
                          <thead>
                            <tr style={{ background: '#f9fafb' }}>
                              {['Course', 'Mode', 'Options', 'Overlap', 'Surviving', 'Prim. grp (pre)', 'Prim. grp (post)', 'Status'].map((h) => (
                                <th key={h} style={{ padding: '2px 6px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {s.requests.map((r) => (
                              <tr key={r.code} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                <td style={{ padding: '2px 6px', fontWeight: 600 }}>{r.code}</td>
                                <td style={{ padding: '2px 6px', color: '#6b7280' }}>{r.constraintMode}</td>
                                <td style={{ padding: '2px 6px' }}>{r.allOptionsCount}</td>
                                <td style={{ padding: '2px 6px', color: r.overlappingCount > 0 ? '#d97706' : 'inherit' }}>{r.overlappingCount}</td>
                                <td style={{ padding: '2px 6px' }}>{r.survivingOptionsCount}</td>
                                <td style={{ padding: '2px 6px', color: '#6b7280' }}>{r.primaryGroupsBeforeZlp ?? '—'}</td>
                                <td style={{ padding: '2px 6px', color: r.constrainedForSelfConflict ? '#d97706' : '#6b7280', fontWeight: r.constrainedForSelfConflict ? 600 : 400 }}>
                                  {r.primaryGroupsAfterZlp ?? '—'}{r.constrainedForSelfConflict ? ' ⚠' : ''}
                                </td>
                                <td style={{ padding: '2px 6px', color: r.directConflict ? '#dc2626' : r.blocked ? '#d97706' : '#16a34a', fontWeight: 600 }}>
                                  {r.directConflict ? 'Conflict' : r.blocked ? 'Blocked' : 'OK'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </details>
        )}

        <p style={{ fontSize: 11, color: '#9ca3af', margin: '10px 0 0', borderTop: '1px solid #e5e7eb', paddingTop: 10 }}>
          Direct conflicts and partially blocked requests are counted exactly.
          <br /><br />
          Self-conflict checks whether a student can still build a full schedule after the ZLP time is added. To keep this efficient, the algorithm uses a heuristic: if every course still has at least 3 distinct lecture-time patterns available, the student is treated as low-risk and the solver is skipped.
          <br /><br />
          Low-risk skipped cases are treated as schedulable. Only confirmed <em>Self-conflict</em> and <em>Unknown — solver limit</em> results count against window scoring.
        </p>
      </div>
      {viewCourse && (
        <CourseSectionsViewerModal
          code={viewCourse.code}
          title={viewCourse.title}
          termCode={termCode}
          highlightSections={viewCourse.highlightSections}
          isPreferred={viewCourse.isPreferred}
          onClose={() => setViewCourse(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canonical column definitions — single source of truth for headers and cells.
// Both the <thead> and every row (single or grouped) iterate the same array so
// header count === cell count for every mode combination.
// ---------------------------------------------------------------------------
function buildWindowColumns(checkFeasibility, isRequiredOnly) {
  return [
    { key: 'rank',                 label: 'Rank',                   align: 'left'                                  },
    { key: 'day',                  label: 'Day',                    align: 'left'                                  },
    { key: 'start',                label: 'Start',                  align: 'left'                                  },
    { key: 'end',                  label: 'End',                    align: 'left'                                  },
    { key: 'totalHardConflicts',   label: 'Total Hard Conflicts',   align: 'right', maxKey: 'totalHardConflicts'   },
    { key: 'conflictRequests',     label: 'Direct Conflict Req',    align: 'right', maxKey: 'conflictRequests'     },
    { key: 'affectedStudents',     label: 'Conflict-Affected',      align: 'right', maxKey: 'affectedStudents'     },
    ...(checkFeasibility ? [
      { key: 'selfConflictStudents', label: 'Self-Conflict',        align: 'right', maxKey: 'selfConflictStudents' },
    ] : []),
    { key: 'nonLabBlockedRequests', label: 'Non-Lab Blocked Req',  align: 'right', maxKey: 'nonLabBlockedRequests' },
    { key: 'blockedRequests',       label: 'Partial Block Req',    align: 'right', maxKey: 'blockedRequests'       },
    { key: 'blockedStudents',       label: 'Block-Affected',       align: 'right', maxKey: 'blockedStudents'       },
    ...(isRequiredOnly ? [
      { key: 'prefHardConflicts',    label: 'Pref. Hard Conflicts', align: 'right', maxKey: 'prefHardConflicts'    },
      { key: 'prefAffectedStudents', label: 'Pref. Affected',       align: 'right', maxKey: 'prefAffectedStudents' },
    ] : []),
    // Section Prefs Affected \u2014 the last non-unknown column, right after Pref.
    // Affected and before the unknown columns.
    { key: 'sectionPrefsAffected', label: 'Sect.-Pref. Affected', align: 'right', maxKey: 'sectionPrefsAffected' },
    ...(isRequiredOnly ? [
      { key: 'prefUnknown',          label: '\u26a0 Pref. Unknown', align: 'center'                               },
    ] : []),
    ...(checkFeasibility ? [
      { key: 'feasibilityUnknown', label: '\u26a0 Unknown',         align: 'center'                               },
    ] : []),
  ];
}

// Purple heatmap background for the Section Prefs Affected column — light at 0,
// deeper purple as the count approaches the max across windows.
function sectionPrefBg(value, max) {
  if (!max || !value) return '#faf5ff';
  const ratio = Math.min(value / max, 1);
  return `rgba(109, 40, 217, ${(0.1 + ratio * 0.4).toFixed(2)})`;
}

/** Extract the display value for a column key from a window object. */
function getWindowValue(win, colKey) {
  switch (colKey) {
    case 'totalHardConflicts':   return win.totalHardConflicts ?? ((win.conflictRequests ?? 0) + (win.selfConflictStudents ?? 0));
    case 'conflictRequests':     return win.conflictRequests ?? 0;
    case 'affectedStudents':     return win.affectedStudents ?? 0;
    case 'selfConflictStudents': return win.selfConflictStudents ?? win.selfBlockedStudents ?? 0;
    case 'nonLabBlockedRequests': return win.nonLabBlockedRequests ?? 0;
    case 'blockedRequests':      return win.blockedRequests ?? 0;
    case 'blockedStudents':      return win.blockedStudents ?? 0;
    case 'feasibilityUnknown':   return win.feasibilityUnknownCount ?? win.feasibilityUnknownStudents?.length ?? 0;
    case 'prefHardConflicts':    return win.preferredHardConflictImpact?.preferredHardConflicts ?? 0;
    case 'prefAffectedStudents': return win.preferredHardConflictImpact?.preferredAffectedStudents ?? 0;
    case 'prefUnknown':          return win.preferredHardConflictImpact?.preferredFeasibilityUnknownStudents ?? 0;
    case 'sectionPrefsAffected': {
      // Required/Preferred have the impact-pass count; Sections-Preferred derives
      // it from the restricted students in its own conflict/blocked cards.
      if (win.preferredHardConflictImpact?.preferredRestrictedStudents != null) {
        return win.preferredHardConflictImpact.preferredRestrictedStudents;
      }
      const s = new Set();
      for (const c of (win.conflictCourses ?? [])) for (const n of (c.restrictedStudentNames ?? [])) s.add(n);
      for (const c of (win.blockedCourses  ?? [])) for (const n of (c.restrictedStudentNames ?? [])) s.add(n);
      return s.size;
    }
    default:                     return null;
  }
}

// ---------------------------------------------------------------------------
// WindowRow — clickable row in the ranked windows table (click opens modal)
// ---------------------------------------------------------------------------
function WindowRow({ win, onOpenModal, maxValues, checkFeasibility = false, isRequiredOnly = false }) {
  const cols   = buildWindowColumns(checkFeasibility, isRequiredOnly);
  const cellBg = (value, max) => {
    if (max === 0 || value === 0) return '#f0fdf4';
    const ratio = Math.min(value / max, 1);
    if (ratio < 0.5) {
      const r = Math.round(ratio * 2 * 255);
      return `rgba(${r},200,0,0.18)`;
    }
    const g = Math.round((1 - (ratio - 0.5) * 2) * 200);
    return `rgba(220,${g},0,0.22)`;
  };
  const cs = (value, maxKey) => ({
    padding: '6px 8px', textAlign: 'right',
    background: cellBg(value ?? 0, maxValues?.[maxKey] ?? 0),
  });

  function renderCell(col) {
    const { key, maxKey } = col;
    switch (key) {
      case 'rank':
        return <td key={key} style={{ padding: '6px 8px', fontWeight: 600 }}>#{win.rank}</td>;
      case 'day':
        return <td key={key} style={{ padding: '6px 8px' }}>{win.dayLabel ?? DAYS_DISPLAY[win.day] ?? win.day}</td>;
      case 'start':
        return <td key={key} style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{win.startTime}</td>;
      case 'end':
        return <td key={key} style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{win.endTime}</td>;
      case 'totalHardConflicts':
      case 'conflictRequests': {
        const v = getWindowValue(win, key);
        return <td key={key} style={cs(v, maxKey)}><span style={{ fontWeight: 700 }}>{v}</span></td>;
      }
      case 'affectedStudents':
      case 'selfConflictStudents':
      case 'nonLabBlockedRequests':
      case 'blockedRequests':
      case 'blockedStudents': {
        const v = getWindowValue(win, key);
        return <td key={key} style={cs(v, maxKey)}>{v}</td>;
      }
      case 'feasibilityUnknown': {
        const v = getWindowValue(win, key);
        return (
          <td key={key} style={{ padding: '6px 8px', textAlign: 'center' }}>
            {v > 0 && (
              <span style={{ color: '#b45309', fontWeight: 700, fontSize: 11 }}
                title={`Feasibility unknown for ${v} student(s)`}>
                {'⚠'}&nbsp;{v}
              </span>
            )}
          </td>
        );
      }
      case 'prefHardConflicts': {
        const v = getWindowValue(win, key);
        const hasPref = Boolean(win.preferredHardConflictImpact);
        return (
          <td key={key} style={cs(v, maxKey)}>
            <span style={{ fontWeight: v > 0 ? 600 : 400, color: v > 0 ? '#d97706' : 'inherit' }}>
              {hasPref ? v : '—'}
            </span>
          </td>
        );
      }
      case 'prefAffectedStudents': {
        const v = getWindowValue(win, key);
        const hasPref = Boolean(win.preferredHardConflictImpact);
        return <td key={key} style={cs(v, maxKey)}>{hasPref ? v : '—'}</td>;
      }
      case 'prefUnknown': {
        const v = getWindowValue(win, key);
        return (
          <td key={key} style={{ padding: '6px 8px', textAlign: 'center' }}>
            {v > 0 && (
              <span style={{ color: '#b45309', fontWeight: 700, fontSize: 11 }} title={`Pref. feasibility unknown: ${v}`}>
                {'⚠'}&nbsp;{v}
              </span>
            )}
          </td>
        );
      }
      case 'sectionPrefsAffected': {
        const v = getWindowValue(win, key);
        return <td key={key} style={{ padding: '6px 8px', textAlign: 'right', background: sectionPrefBg(v, maxValues?.sectionPrefsAffected ?? 0), color: '#4c1d95', fontWeight: v > 0 ? 600 : 400 }}>{v}</td>;
      }
      default:
        return <td key={key} />;
    }
  }

  return (
    <tr data-rank={win.rank} style={{ cursor: 'pointer' }} onClick={() => onOpenModal(win)}>
      {cols.map(renderCell)}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// groupIdenticalWindows — collapse consecutive windows with same stats into groups
// ---------------------------------------------------------------------------
function groupIdenticalWindows(windows) {
  const statKey = (w) => [
    w.day,
    w.conflictRequests ?? 0,
    w.affectedStudents ?? 0,
    w.selfConflictStudents ?? w.selfBlockedStudents ?? 0,
    w.nonLabBlockedRequests ?? 0,
    w.blockedRequests ?? 0,
    w.blockedStudents ?? 0,
    w.feasibilityUnknownCount ?? 0,
  ].join('|');
  const groups = [];
  for (const win of windows) {
    const last = groups[groups.length - 1];
    if (last && statKey(last[0]) === statKey(win)) {
      last.push(win);
    } else {
      groups.push([win]);
    }
  }
  return groups;
}

// WindowGroupRow — renders a single WindowRow or a collapsed multi-window range row
function WindowGroupRow({ group, onOpenModal, maxValues, checkFeasibility, isRequiredOnly = false }) {
  if (group.length === 1) {
    const win = group[0];
    return (
      <WindowRow
        win={win}
        onOpenModal={onOpenModal}
        maxValues={maxValues}
        checkFeasibility={checkFeasibility}
        isRequiredOnly={isRequiredOnly}
      />
    );
  }

  const first = group[0];
  const last  = group[group.length - 1];
  const cols  = buildWindowColumns(checkFeasibility, isRequiredOnly);

  const cellBg = (value, max) => {
    if (max === 0 || value === 0) return '#f0fdf4';
    const ratio = Math.min(value / max, 1);
    if (ratio < 0.5) { const r = Math.round(ratio * 2 * 255); return `rgba(${r},200,0,0.18)`; }
    const g = Math.round((1 - (ratio - 0.5) * 2) * 200);
    return `rgba(220,${g},0,0.22)`;
  };
  const cs = (value, maxKey) => ({
    padding: '6px 8px', textAlign: 'right',
    background: cellBg(value ?? 0, maxValues?.[maxKey] ?? 0),
  });

  function renderCell(col) {
    const { key, maxKey } = col;
    switch (key) {
      case 'rank':
        return (
          <td key={key} style={{ padding: '6px 8px', fontWeight: 600, color: '#4b5563' }}>
            #{first.rank}–#{last.rank}
            <span style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic', marginLeft: 4 }}>({group.length}×)</span>
          </td>
        );
      case 'day':
        return <td key={key} style={{ padding: '6px 8px' }}>{first.dayLabel ?? DAYS_DISPLAY[first.day] ?? first.day}</td>;
      case 'start':
        return <td key={key} style={{ padding: '6px 8px', whiteSpace: 'nowrap', fontStyle: 'italic', color: '#4b5563' }}>{first.startTime}–{last.startTime}</td>;
      case 'end':
        return <td key={key} style={{ padding: '6px 8px', whiteSpace: 'nowrap', fontStyle: 'italic', color: '#4b5563' }}>{first.endTime}–{last.endTime}</td>;
      case 'totalHardConflicts':
      case 'conflictRequests': {
        const v = getWindowValue(first, key);
        return <td key={key} style={cs(v, maxKey)}><span style={{ fontWeight: 700 }}>{v}</span></td>;
      }
      case 'affectedStudents':
      case 'selfConflictStudents':
      case 'nonLabBlockedRequests':
      case 'blockedRequests':
      case 'blockedStudents': {
        const v = getWindowValue(first, key);
        return <td key={key} style={cs(v, maxKey)}>{v}</td>;
      }
      case 'feasibilityUnknown': {
        const v = getWindowValue(first, key);
        return (
          <td key={key} style={{ padding: '6px 8px', textAlign: 'center' }}>
            {v > 0 && (
              <span style={{ color: '#b45309', fontWeight: 700, fontSize: 11 }}>
                {'⚠ '}{v}
              </span>
            )}
          </td>
        );
      }
      case 'prefHardConflicts': {
        const v = getWindowValue(first, key);
        const hasPref = Boolean(first.preferredHardConflictImpact);
        return (
          <td key={key} style={cs(v, maxKey)}>
            <span style={{ fontWeight: v > 0 ? 600 : 400, color: v > 0 ? '#d97706' : 'inherit' }}>
              {hasPref ? v : '—'}
            </span>
          </td>
        );
      }
      case 'prefAffectedStudents': {
        const v = getWindowValue(first, key);
        const hasPref = Boolean(first.preferredHardConflictImpact);
        return <td key={key} style={cs(v, maxKey)}>{hasPref ? v : '—'}</td>;
      }
      case 'prefUnknown': {
        const v = getWindowValue(first, key);
        return (
          <td key={key} style={{ padding: '6px 8px', textAlign: 'center' }}>
            {v > 0 && (
              <span style={{ color: '#b45309', fontWeight: 700, fontSize: 11 }} title={`Pref. feasibility unknown: ${v}`}>
                {'⚠ '}{v}
              </span>
            )}
          </td>
        );
      }
      case 'sectionPrefsAffected': {
        const v = getWindowValue(first, key);
        return <td key={key} style={{ padding: '6px 8px', textAlign: 'right', background: sectionPrefBg(v, maxValues?.sectionPrefsAffected ?? 0), color: '#4c1d95', fontWeight: v > 0 ? 600 : 400 }}>{v}</td>;
      }
      default:
        return <td key={key} />;
    }
  }

  return (
    <tr
      style={{ cursor: 'pointer', borderTop: '2px solid var(--color-border, #e5e7eb)' }}
      onClick={() => onOpenModal(first)}
    >
      {cols.map(renderCell)}
    </tr>
  );
}
// ResultsPanel — heatmap + ranked windows for one run
// ---------------------------------------------------------------------------

/** Select "best" windows: all score<=1, else fill to top 10 if not exceeded */
function selectBestWindows(windows) {
  const low  = windows.filter((w) => w.conflictRequests <= 1);
  const rest = windows.filter((w) => w.conflictRequests > 1);
  if (low.length >= 10) return { best: low, extra: rest };
  const fill = rest.slice(0, 10 - low.length);
  return { best: [...low, ...fill], extra: rest.slice(10 - low.length) };
}

function ResultsPanel({ run, cohortId, cycleId }) {
  const [selectedCell, setSelectedCell]     = useState(null);
  const [modalWin,     setModalWin]         = useState(null);
  const [showAllWins,  setShowAllWins]      = useState(false);
  const [showHeatmap,  setShowHeatmap]      = useState(true);
  const [showWindows,     setShowWindows]    = useState(true);
  const [fullscreenTable, setFullscreenTable] = useState(false);
  const tableRef = useRef(null);

  // Escape exits fullscreen
  useEffect(() => {
    if (!fullscreenTable) return;
    const handler = (e) => { if (e.key === 'Escape') setFullscreenTable(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreenTable]);

  if (!run || run.status !== 'completed') return null;

  const { windows = [], heatmap = {} } = run.results ?? {};
  const legacyMode = run.parameters?.legacyMode ?? false;
  const checkFeasibility = !legacyMode; // self-conflict shown unless legacy mode
  const { best: bestWindows, extra: extraWindows } = selectBestWindows(windows);

  const handleCellClick = (time, day) => {
    setSelectedCell({ time, day });
    // Find the window by startTime + day and open the modal
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const startMin = toMin(time);
    const win = windows.find((w) => w.startMinutes === startMin && w.day === day);
    if (win) setModalWin(win);
  };

  const visibleWindows = showAllWins ? windows : bestWindows;
  const visibleGroups  = groupIdenticalWindows(visibleWindows);
  const isRequiredOnly = run.mode === 'required_only';
  const maxValues = visibleWindows.reduce((acc, w) => ({
    totalHardConflicts:   Math.max(acc.totalHardConflicts,   w.totalHardConflicts  ?? (w.conflictRequests + (w.selfConflictStudents ?? 0))),
    conflictRequests:    Math.max(acc.conflictRequests,    w.conflictRequests    ?? 0),
    affectedStudents:    Math.max(acc.affectedStudents,    w.affectedStudents    ?? 0),
    selfConflictStudents: Math.max(acc.selfConflictStudents, w.selfConflictStudents ?? w.selfBlockedStudents ?? 0),
    nonLabBlockedRequests: Math.max(acc.nonLabBlockedRequests ?? 0, w.nonLabBlockedRequests ?? 0),
    blockedRequests:     Math.max(acc.blockedRequests,     w.blockedRequests     ?? 0),
    blockedStudents:     Math.max(acc.blockedStudents,     w.blockedStudents     ?? 0),
    prefHardConflicts:   Math.max(acc.prefHardConflicts   ?? 0, w.preferredHardConflictImpact?.preferredHardConflicts   ?? 0),
    prefAffectedStudents:Math.max(acc.prefAffectedStudents ?? 0, w.preferredHardConflictImpact?.preferredAffectedStudents ?? 0),
    sectionPrefsAffected:Math.max(acc.sectionPrefsAffected ?? 0, getWindowValue(w, 'sectionPrefsAffected')),
  }), { totalHardConflicts: 0, conflictRequests: 0, affectedStudents: 0, selfConflictStudents: 0, nonLabBlockedRequests: 0, blockedRequests: 0, blockedStudents: 0, prefHardConflicts: 0, prefAffectedStudents: 0, sectionPrefsAffected: 0 });

  return (
    <div style={{ minWidth: 0, width: '100%' }}>
      {/* Modal */}
      {modalWin && (
        <WindowDetailModal win={modalWin} onClose={() => setModalWin(null)} cohortId={cohortId} cycleId={cycleId} termCode={run.parameters?.termCode ?? null} checkFeasibility={checkFeasibility} runMode={run.mode} />
      )}

      {/* Summary cards */}
      <RunSummaryCards run={run} />

      {/* Run metadata (Phase 8: confirm we're looking at a fresh run) */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 16, alignItems: 'center' }}>
        <span title="Algorithm run ID"><strong>Run:</strong> {String(run._id).slice(-8)}</span>
        <span>·</span>
        <span title="When this run was created"><strong>Created:</strong> {run.createdAt ? new Date(run.createdAt).toLocaleString() : '—'}</span>
        <span>·</span>
        <span><strong>Mode:</strong> {modeLabel(run.mode)}</span>
        <span>·</span>
        <span><strong>Term:</strong> {run.results?.courseSectionSummary?.[0] ? (run.parameters?.termCode ?? '—') : '—'}</span>
        <span>·</span>
        <span><strong>Solver:</strong> v{run.parameters?.solverVersion ?? '?'}</span>
      </div>

      {/* Warnings */}
      {run.warnings?.length > 0 && (
        <div className="alert alert-warn" style={{ marginBottom: 16 }}>
          <strong>Warnings ({run.warnings.length}):</strong>
          <ul style={{ margin: '8px 0 0 16px', fontSize: 12 }}>
            {run.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* Legacy mode notice */}
      {legacyMode && (
        <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 6, background: '#fffbeb', border: '1px solid #fde68a', fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ fontWeight: 700, flexShrink: 0 }}>&#x26A0;</span>
          <span>
            <strong>Legacy Python scheduler mode enabled!</strong> ALL self-conflict checks were skipped.
          </span>
        </div>
      )}

      {/* Heatmap */}
      <div className="card" style={{ marginBottom: 20, background: '#f4f4f5' }}>
        <div
          onClick={() => setShowHeatmap((v) => !v)}
          title={showHeatmap ? 'Click to minimize' : 'Click to expand'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: showHeatmap ? 12 : 0, cursor: 'pointer', userSelect: 'none' }}
        >
          <h3 style={{ margin: 0, fontSize: 15 }}>
            Conflict Heatmap
            {showHeatmap && (
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-text-muted)', marginLeft: 8 }}>
                &mdash; click a cell for window details
              </span>
            )}
          </h3>
          <span
            style={{
              background: 'none', border: '1px solid var(--color-border, #d1d5db)',
              borderRadius: 6, padding: '3px 10px',
              fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            {showHeatmap ? '\u2212 Minimize' : '+ Expand'}
          </span>
        </div>
        {showHeatmap && (
          <>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12, marginTop: 4 }}>
              Cell value = total hard conflicts: direct conflicts + self-conflicts. Green = 0, Red = max.
              {!checkFeasibility && ' Legacy mode: self-conflict excluded, so cell value equals direct conflicts only.'}
            </p>
            <HeatmapGrid
              heatmap={heatmap}
              windows={windows}
              onCellClick={handleCellClick}
              selectedTime={selectedCell?.time}
              selectedDay={selectedCell?.day}
              checkFeasibility={checkFeasibility}
              onBackgroundClick={() => setShowHeatmap(false)}
            />
          </>
        )}
      </div>

      {/* Best Windows table */}
      <div
        className="card"
        style={fullscreenTable
          ? { position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', flexDirection: 'column', background: 'var(--color-card-bg,#fff)', overflowY: 'auto', borderRadius: 0, margin: 0 }
          : { marginBottom: 20, background: '#f4f4f5' }}
      >
        <div
          onClick={() => setShowWindows((v) => !v)}
          title={showWindows ? 'Click to minimize' : 'Click to expand'}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: showWindows ? 8 : 0, cursor: 'pointer', userSelect: 'none', flexWrap: 'wrap', gap: 8 }}
        >
          <h3 style={{ margin: 0, fontSize: 15 }}>
            Best Windows
            <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--color-text-muted)', marginLeft: 8 }}>
              ({bestWindows.length} shown{bestWindows.length < windows.length ? ` of ${windows.length}` : ''})
            </span>
          </h3>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setFullscreenTable((f) => !f); if (!showWindows) setShowWindows(true); }}
              title={fullscreenTable ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
              style={{
                background: 'none', border: '1px solid var(--color-border, #d1d5db)',
                borderRadius: 6, padding: '3px 10px',
                fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4,
                cursor: 'pointer',
              }}
            >
              {fullscreenTable ? '✕ Exit Fullscreen' : '⛶ Fullscreen'}
            </button>
            <span
              style={{
                background: 'none', border: '1px solid var(--color-border, #d1d5db)',
                borderRadius: 6, padding: '3px 10px',
                fontSize: 12, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              {showWindows ? '− Minimize' : '+ Expand'}
            </span>
          </span>
        </div>
        {showWindows && <>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--color-text-muted)' }}>
            All windows with Conflict Requests &le; 1, filled to 10 with next-best.
            Click any row to view full details. Rows with identical scores show a range, click to open the first.
          </p>
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
            <table ref={tableRef} style={{ borderCollapse: 'collapse', width: '100%', minWidth: 700, fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--color-border, #e5e7eb)' }}>
                  {buildWindowColumns(checkFeasibility, isRequiredOnly).map((col) => (
                    <th key={col.key} style={{
                      padding: '6px 8px',
                      textAlign: col.align ?? 'left',
                      whiteSpace: 'nowrap',
                      background: 'var(--color-card-bg, #fff)',
                    }}>
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleGroups.map((group) => (
                  <WindowGroupRow
                    key={group[0].rank}
                    group={group}
                    onOpenModal={setModalWin}
                    maxValues={maxValues}
                    checkFeasibility={checkFeasibility}
                    isRequiredOnly={isRequiredOnly}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Show all / collapse toggle */}
          {extraWindows.length > 0 && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border, #e5e7eb)', paddingTop: 10 }}>
              <button
                className="link-btn"
                onClick={(e) => { e.stopPropagation(); setShowAllWins((v) => !v); }}
              >
                {showAllWins
                  ? `\u25B2 Show best windows only`
                  : `\u25BC Show all ${windows.length} windows (${extraWindows.length} additional)`}
              </button>
            </div>
          )}
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DebugInputPanel — diagnostic report for a cohort/cycle pair
// ---------------------------------------------------------------------------
function DebugInputPanel({ cohortId, cycleId }) {
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [report,  setReport]  = useState(null);
  const [err,     setErr]     = useState('');

  const canRun = Boolean(cohortId && cycleId);

  function handleToggle() {
    if (!open && !report && canRun) {
      setLoading(true);
      setErr('');
      getAlgorithmDebugInput(cohortId, cycleId)
        .then((res) => setReport(res.data))
        .catch((e) => setErr(e?.response?.data?.error ?? e.message ?? 'Diagnostic failed.'))
        .finally(() => setLoading(false));
    }
    setOpen((v) => !v);
  }

  function handleRefresh() {
    if (!canRun) return;
    setLoading(true);
    setReport(null);
    setErr('');
    getAlgorithmDebugInput(cohortId, cycleId)
      .then((res) => setReport(res.data))
      .catch((e) => setErr(e?.response?.data?.error ?? e.message ?? 'Diagnostic failed.'))
      .finally(() => setLoading(false));
  }

  const STATUS_COLORS = {
    found:                    '#22c55e',
    course_not_offered:       '#f59e0b',
    rows_exist_no_meeting_times: '#f59e0b',
    subject_not_in_term:      '#ef4444',
    no_term_data:             '#ef4444',
    not_found:                '#ef4444',
  };

  const STATUS_LABELS = {
    found:                    'Found',
    course_not_offered:       'Not offered this term',
    rows_exist_no_meeting_times: 'No usable meeting times',
    subject_not_in_term:      'Subject not in term',
    no_term_data:             'No term data returned',
    not_found:                'Not found',
  };

  return (
    <div className="card" style={{ marginBottom: 20, padding: '12px 16px', border: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="btn-secondary"
          onClick={handleToggle}
          disabled={!canRun}
          style={{ fontSize: 12, padding: '4px 12px' }}
        >
          {open ? '\u25B2' : '\u25BC'} Debug Input
        </button>
        {open && (
          <button
            className="btn-secondary"
            onClick={handleRefresh}
            disabled={loading}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            &#8635; Refresh
          </button>
        )}
        {!canRun && (
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Select cohort &amp; cycle first</span>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {loading && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading diagnostic\u2026</p>}
          {err && <p style={{ color: '#ef4444', fontSize: 13 }}>{err}</p>}
          {report && (
            <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* Cycle / Term */}
              <div>
                <strong>Cycle:</strong> {report.cycle.name || report.cycle._id} &mdash;{' '}
                <strong>Term:</strong> {report.cycle.termLabel} &mdash;{' '}
                <strong>termCode:</strong>{' '}
                <code style={{ background: 'var(--color-bg-subtle)', padding: '1px 4px', borderRadius: 3 }}>
                  {report.cycle.termCode}
                </code>{' '}
                &mdash; <strong>Status:</strong> {report.cycle.status}
              </div>

              {/* Counts */}
              <div>
                <strong>Members:</strong> {report.counts.cohortMembers} &mdash;{' '}
                <strong>Submitted:</strong> {report.counts.submittedSubmissions} &mdash;{' '}
                <strong>Requests (total):</strong> {report.counts.courseRequestsTotal} &mdash;{' '}
                <strong>Required Only included:</strong> {report.counts.requiredOnlyIncluded} &mdash;{' '}
                <strong>Req+Pref included:</strong> {report.counts.requiredPlusPreferredIncluded}
              </div>

              {/* Algorithm Grid */}
              <div>
                <strong>Grid:</strong>{' '}
                {report.algorithmGrid.firstStart}&ndash;{report.algorithmGrid.lastStart},{' '}
                {report.algorithmGrid.stepMinutes}-min step &rarr;{' '}
                <span style={{ color: report.algorithmGrid.actualWindows === 495 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                  {report.algorithmGrid.startsCount} starts &times; {report.algorithmGrid.weekdaysCount} days = {report.algorithmGrid.actualWindows} windows
                  {report.algorithmGrid.actualWindows !== 495 && ' (expected 495!)'}
                </span>
              </div>

              {/* Term section stats */}
              <div>
                <strong>Howdy raw rows for termCode {report.termSectionStats.termCode}:</strong>{' '}
                <span style={{ color: report.termSectionStats.totalRawRowsFromHowdy === 0 ? '#ef4444' : 'inherit' }}>
                  {report.termSectionStats.totalRawRowsFromHowdy}
                </span>
                {report.termSectionStats.sectionFetchError && (
                  <span style={{ color: '#ef4444', marginLeft: 8 }}>
                    Error: {report.termSectionStats.sectionFetchError}
                  </span>
                )}
                {report.termSectionStats.totalRawRowsFromHowdy > 0 && (
                  <span style={{ marginLeft: 8, color: 'var(--color-text-muted)' }}>
                    Subjects: {report.termSectionStats.subjectsPresent.slice(0, 20).join(', ')}
                    {report.termSectionStats.subjectsPresent.length > 20 ? '...' : ''}
                  </span>
                )}
              </div>

              {/* Per-course section lookup */}
              {report.sectionLookup.length > 0 && (
                <div>
                  <strong>Section lookup per course:</strong>
                  <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 6 }}>
                    <thead>
                      <tr style={{ background: 'var(--color-bg-subtle)' }}>
                        {['Course', 'Raw rows', 'Normalized opts', 'Status'].map((h) => (
                          <th key={h} style={{ padding: '3px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--color-border)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {report.sectionLookup.map((s) => (
                        <tr key={s.code}>
                          <td style={{ padding: '3px 8px', fontWeight: 600 }}>{s.code}</td>
                          <td style={{ padding: '3px 8px' }}>{s.rawSectionsFound}</td>
                          <td style={{ padding: '3px 8px' }}>{s.normalizedOptionsFound}</td>
                          <td style={{ padding: '3px 8px' }}>
                            <span style={{
                              color: STATUS_COLORS[s.matchStatus] ?? 'inherit',
                              fontWeight: s.matchStatus !== 'found' ? 600 : 400,
                            }}>
                              {STATUS_LABELS[s.matchStatus] ?? s.matchStatus}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Preferred sections */}
              <div>
                <strong>Preferred sections saved:</strong> {report.preferredSections.savedCount} &mdash;{' '}
                <span style={{ color: '#6b7280' }}>Not used in Required Only &mdash; Used as section constraints in Required + Preferred</span>
              </div>

              {/* Warnings */}
              {report.warnings.length > 0 && (
                <div>
                  <strong style={{ color: '#f59e0b' }}>Warnings ({report.warnings.length}):</strong>
                  <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    {report.warnings.map((w, i) => (
                      <li key={i} style={{ color: '#f59e0b' }}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Course requests table */}
              {report.courseRequests.length > 0 && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                    Course requests ({report.courseRequests.length})
                  </summary>
                  <div style={{ overflowX: 'auto', marginTop: 6 }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 11, minWidth: 600 }}>
                      <thead>
                        <tr style={{ background: 'var(--color-bg-subtle)' }}>
                          {['Student', 'Code', 'Final class.', 'Sys. class.', 'Override', 'Sub. status', 'Req Only', 'Req+Pref'].map((h) => (
                            <th key={h} style={{ padding: '2px 6px', textAlign: 'left', borderBottom: '1px solid var(--color-border)', fontWeight: 600 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.courseRequests.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                            <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>{r.studentName}</td>
                            <td style={{ padding: '2px 6px', fontWeight: 600 }}>{r.code}</td>
                            <td style={{ padding: '2px 6px', color: r.finalClassification === 'required' ? '#22c55e' : r.finalClassification === 'preferred' ? '#f59e0b' : r.finalClassification === 'not_applied' ? '#ef4444' : 'inherit' }}>{r.finalClassification}</td>
                            <td style={{ padding: '2px 6px' }}>{r.systemClassification}</td>
                            <td style={{ padding: '2px 6px' }}>{r.overrideStatus === 'manual_override' ? '✎ override' : ''}</td>
                            <td style={{ padding: '2px 6px' }}>{r.submissionStatus}</td>
                            <td style={{ padding: '2px 6px', textAlign: 'center' }}>{r.includedInRequiredOnly ? '\u2713' : ''}</td>
                            <td style={{ padding: '2px 6px', textAlign: 'center' }}>{r.includedInRequiredPlusPreferred ? '\u2713' : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunTab — select cohort/cycle, configure, run algorithm
// ---------------------------------------------------------------------------
function RunTab({ onRunComplete }) {
  const [cohorts, setCohorts] = useState([]);
  const [cycles,  setCycles]  = useState([]);
  const [cohortId, setCohortId] = useState('');
  const [cycleId,  setCycleId]  = useState('');

  const [legacyMode, setLegacyMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [runResult, setRunResult] = useState(null); // success result pending view
  const [loadingCohorts, setLoadingCohorts] = useState(true);
  const [loadingCycles,  setLoadingCycles]  = useState(false);

  // Load cohorts
  useEffect(() => {
    getCohorts()
      .then((res) => setCohorts(res.data ?? []))
      .catch(() => setError('Failed to load cohorts.'))
      .finally(() => setLoadingCohorts(false));
  }, []);

  // Load cycles when cohort changes
  useEffect(() => {
    if (!cohortId) { setCycles([]); setCycleId(''); return; }
    setLoadingCycles(true);
    getCyclesForCohort(cohortId)
      .then((res) => {
        const all = res.data?.cycles ?? [];
        const active = all.filter((c) => c.status !== 'archived');
        setCycles(active);
        setCycleId(active[0]?._id ?? '');
      })
      .catch(() => setError('Failed to load scheduling cycles.'))
      .finally(() => setLoadingCycles(false));
  }, [cohortId]);

  const selectedCycle = cycles.find((c) => c._id === cycleId);

  const handleRun = async () => {
    if (!cohortId || !cycleId) { setError('Select a cohort and scheduling cycle.'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await runAlgorithm({ cohortId, schedulingCycleId: cycleId, includeDraftSubmissions: false, legacyMode });
      setRunResult(res.data);
    } catch (err) {
      setError(err?.response?.data?.error ?? 'Algorithm run failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* Left column — controls */}
      <div style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 560 }}>
        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

        {loadingCohorts ? (
          <p style={{ color: 'var(--color-text-muted)' }}>Loading cohorts&hellip;</p>
        ) : (
          <>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label>Cohort</label>
              <select value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
                <option value="">Select cohort</option>
                {cohorts.map((c) => (
                  <option key={c._id} value={c._id}>{'  '}{c.name}</option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 16 }}>
              <label>Scheduling Cycle</label>
              {loadingCycles ? (
                <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 13 }}>Loading&hellip;</p>
              ) : (
                <select value={cycleId} onChange={(e) => setCycleId(e.target.value)} disabled={!cohortId}>
                  <option value="">Select cycle</option>
                  {cycles.map((c) => (
                    <option key={c._id} value={c._id}>
                      {'  '}{c.name ?? c.term} ({c.status}) &mdash; {c.termCode}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {selectedCycle && (
              <div className="alert alert-info" style={{ marginBottom: 16, fontSize: 13 }}>
                Term Code: <strong>{selectedCycle.termCode}</strong>
                {selectedCycle.submissionDeadline && (
                  <> &mdash; Deadline: <strong>{new Date(selectedCycle.submissionDeadline).toLocaleDateString()}</strong></>
                )}
              </div>
            )}

            {/* Legacy Python scheduler option */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={legacyMode}
                  onChange={(e) => setLegacyMode(e.target.checked)}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <div>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Use legacy Python scheduler</span>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2, lineHeight: 1.5 }}>
                    Runs the legacy scheduler mode. This skips self-conflict checks and only evaluates direct conflicts/partially blocked course options.
                  </div>
                </div>
              </label>
            </div>

            <div className="subtle-box" style={{ marginBottom: 20, padding: '12px 16px' }}>
              <h4 style={{ margin: '0 0 8px', fontSize: 13 }}><i>Set Parameters</i></h4>
              <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12, color: 'var(--color-text-muted)' }}>
                <li>Block length: 100 minutes</li>
                <li>Step size: 5 minutes</li>
                <li>Grid: 08:00 &ndash; 16:10 latest start (99 starts &times; 5 days = 495 windows)</li>
                <li>Days: Monday &ndash; Friday</li>
                <li>Runs three times: Required, Preferred &amp; Sections-Preferred</li>
              </ul>
            </div>

            {/* DebugInputPanel — developer only, hidden from admin view */}
            {false && <DebugInputPanel cohortId={cohortId} cycleId={cycleId} />}

            <button
              className="btn-primary"
              onClick={handleRun}
              disabled={loading || !cohortId || !cycleId}
              style={{ padding: '10px 28px', fontSize: 15, borderRadius: 6 }}
            >
              {loading ? 'Running\u2026' : '\u25b6 Run Algorithm'}
            </button>
            {loading && (
              <p style={{ marginTop: 12, color: 'var(--color-text-muted)', fontSize: 13 }}>
                Fetching section data and evaluating windows&hellip; this may take up to a minute.
              </p>
            )}
            {runResult && !loading && (
              <div style={{
                marginTop: 16,
                padding: '14px 18px',
                borderRadius: 8,
                background: '#f0fdf4',
                border: '1px solid #bbf7d0',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}>
                <img src="/icon-check-circle.png" alt="" style={{ width: 20, height: 20, filter: 'invert(27%) sepia(89%) saturate(400%) hue-rotate(95deg) brightness(96%) contrast(96%)' }} />
                <span style={{ fontWeight: 600, fontSize: 14, color: '#15803d' }}>Algorithm completed successfully.</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  <button
                    className="btn-primary"
                    onClick={() => { onRunComplete?.(runResult, cohortId, cycleId); setRunResult(null); }}
                    style={{ padding: '6px 16px', fontSize: 13, background: '#16a34a', borderColor: '#16a34a', display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    View Results
                    <img src="/icon-arrow-right.png" alt="" style={{ width: 16, height: 16, filter: 'brightness(0) invert(1)' }} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Right column — info panel */}
      <div style={{ flex: '1 1 260px', minWidth: 260 }}>
        <AlgorithmInfoPanel />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResultsTab — browse previous runs
// ---------------------------------------------------------------------------
function ResultsTab({ jumpToRunId, jumpCohortId, jumpCycleId }) {
  const [cohorts, setCohorts]   = useState([]);
  const [cycles,  setCycles]    = useState([]);
  const [cohortId, setCohortId] = useState('');
  const [cycleId,  setCycleId]  = useState('');
  const [runs, setRuns]         = useState([]);
  const [selectedRunId,  setSelectedRunId]  = useState('');
  const [selectedMode,   setSelectedMode]   = useState('required_only');
  const [fullRun,        setFullRun]        = useState(null);
  const [loading,        setLoading]        = useState(false);
  const [loadingRun,     setLoadingRun]     = useState(false);
  const [error,          setError]          = useState('');
  const [downloading,    setDownloading]    = useState('');

  // Pre-populate cohort/cycle when coming from a fresh run
  useEffect(() => {
    if (jumpCohortId) setCohortId(jumpCohortId);
  }, [jumpCohortId]);
  useEffect(() => {
    if (jumpCycleId) setCycleId(jumpCycleId);
  }, [jumpCycleId]);

  // Auto-jump to the run from a fresh algorithm execution
  const jumpApplied = useRef(null);
  useEffect(() => {
    if (jumpToRunId && runs.length > 0 && jumpApplied.current !== jumpToRunId) {
      const direct = runs.find((r) => r._id === jumpToRunId);
      if (direct) { setSelectedRunId(direct._id); jumpApplied.current = jumpToRunId; return; }
      // Fallback: most recent run
      setSelectedRunId(runs[0]._id);
      jumpApplied.current = jumpToRunId;
    }
  }, [jumpToRunId, runs]);

  const handleDownload = async (runId) => {
    if (downloading || !runId) return;
    setDownloading(runId);
    try {
      const res = await api.get(`/api/admin/algorithm/runs/${runId}/download`, { responseType: 'blob', timeout: 180000 });
      const disposition = res.headers['content-disposition'] ?? '';
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
      const filename = filenameMatch?.[1] ?? `zlp-run-${runId}.xlsx`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
      window.URL.revokeObjectURL(url);
    } catch { alert('Download failed. Please try again.'); }
    finally { setDownloading(''); }
  };

  // Get the peer run for the selected run pair
  const getPeerRun = (mode) => {
    const target = runs.find((r) => r._id === selectedRunId);
    if (!target) return null;
    const pairRuns = runs.filter((r) => Math.abs(new Date(r.createdAt) - new Date(target.createdAt)) < 30000);
    return pairRuns.find((r) => r.mode === mode) ?? null;
  };

  useEffect(() => {
    getCohorts().then((res) => setCohorts(res.data ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!cohortId) { setCycles([]); setCycleId(''); setRuns([]); return; }
    getCyclesForCohort(cohortId)
      .then((res) => {
        const all = res.data?.cycles ?? [];
        setCycles(all);
        // Use jumpCycleId if it belongs to this cohort, else default to first
        const target = jumpCycleId && all.find((c) => c._id === jumpCycleId);
        setCycleId(target ? target._id : (all[0]?._id ?? ''));
      })
      .catch(() => {});
  }, [cohortId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRuns = useCallback(() => {
    if (!cohortId) return;
    setLoading(true);
    getAlgorithmRuns({ cohortId, schedulingCycleId: cycleId || undefined, limit: 30 })
      .then((res) => {
        const all = res.data?.runs ?? [];
        setRuns(all);
        // Default to most recent
        if (all.length > 0) setSelectedRunId(all[0]._id);
      })
      .catch(() => setError('Failed to load runs.'))
      .finally(() => setLoading(false));
  }, [cohortId, cycleId, jumpToRunId]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Load full run when mode or runId changes
  useEffect(() => {
    if (!selectedRunId) { setFullRun(null); return; }
    setLoadingRun(true);
    // The runs list already has pairs — find the one matching the selected mode
    const pairRuns = runs.filter((r) => {
      // Check if created around the same time (paired runs)
      const target = runs.find((x) => x._id === selectedRunId);
      if (!target) return false;
      return Math.abs(new Date(r.createdAt) - new Date(target.createdAt)) < 30000;
    });
    const modeRun = pairRuns.find((r) => r.mode === selectedMode) ?? runs.find((r) => r._id === selectedRunId);

    if (!modeRun) {
      setFullRun(null);
      setLoadingRun(false);
      // Selected run was pruned — fall back to newest available
      if (runs.length > 0) setSelectedRunId(runs[0]._id);
      else setSelectedRunId('');
      return;
    }

    // Stale guard: rapid tab/run switches leave older requests in flight; they
    // must not overwrite the newer selection's data or clear its loading state.
    let stale = false;
    getAlgorithmRun(modeRun._id)
      .then((res) => { if (!stale) setFullRun(res.data?.run ?? null); })
      .catch(() => { if (!stale) setError('Failed to load run details.'); })
      .finally(() => { if (!stale) setLoadingRun(false); });
    return () => { stale = true; };
  }, [selectedRunId, selectedMode, runs]);

  // Group runs into batches (created within 30 seconds of each other) — one batch
  // per algorithm invocation, holding up to 3 mode runs.
  const runPairs = [];
  const seen = new Set();
  for (const r of runs) {
    if (seen.has(r._id)) continue;
    const members = runs
      .filter((x) => !seen.has(x._id) && Math.abs(new Date(x.createdAt) - new Date(r.createdAt)) < 30000)
      .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode));
    members.forEach((x) => seen.add(x._id));
    runPairs.push({ anchor: r, members });
  }

  return (
    <div>
      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ margin: 0, flex: '0 1 auto', width: 320, maxWidth: '100%' }}>
          <label style={{ fontSize: 13 }}>Cohort</label>
          <select style={{ width: '100%' }} value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
            <option value="">All cohorts</option>
            {cohorts.map((c) => <option key={c._id} value={c._id}>{'\u00a0\u00a0'}{c.name}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0, flex: '0 1 auto', width: 320, maxWidth: '100%' }}>
          <label style={{ fontSize: 13 }}>Cycle</label>
          <select style={{ width: '100%' }} value={cycleId} onChange={(e) => setCycleId(e.target.value)} disabled={!cohortId}>
            <option value="">All cycles</option>
            {cycles.map((c) => <option key={c._id} value={c._id}>{'  '}{c.name ?? c.term}</option>)}
          </select>
        </div>
      </div>

      {runs.length === 0 && !loading && (
        <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-muted)' }}>
          No algorithm runs found. Run the algorithm first.
        </div>
      )}

      {runPairs.length > 0 && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', width: '100%', minWidth: 0 }}>
          {/* Run selector sidebar */}
          <div style={{ flex: '0 0 200px', minWidth: 160 }}>
            <strong style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>Run History</strong>
            {runPairs.slice(0, 6).map(({ anchor, members }) => {
              const isSelected = members.some((mr) => mr._id === selectedRunId);
              return (
                <button
                  key={anchor._id}
                  onClick={() => setSelectedRunId(anchor._id)}
                  className={isSelected ? 'list-row active' : 'list-row'}
                  style={{ fontSize: 12, color: isSelected ? '#3b82f6' : 'inherit' }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>
                    {new Date(anchor.createdAt).toLocaleString()}
                  </div>
                  <div style={{ color: isSelected ? '#3b82f6' : 'var(--color-text-muted)' }}>
                    {anchor.status === 'completed' ? '✓ Completed' : anchor.status === 'failed' ? '✗ Failed' : anchor.status}
                  </div>
                  <div style={{ color: 'var(--color-text-muted)', marginTop: 2 }}>
                    {anchor.summary?.totalStudents ?? '?'} students
                  </div>
                  {anchor.parameters?.legacyMode && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, background: '#fef08a', color: '#854d0e', border: '1px solid #fde047', borderRadius: 4, padding: '1px 6px', letterSpacing: '0.04em' }}>LEGACY</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Mode selector + results */}
          <div style={{ flex: '1 1 300px', minWidth: 0, width: 0 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, paddingBottom: 4, borderBottom: '1px solid var(--color-border, #e5e7eb)', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Equal-width columns so the three tabs are evenly distributed
                  regardless of label length (and don't shift when bolded). */}
              <div style={{ display: 'inline-grid', gridAutoFlow: 'column', gridAutoColumns: '1fr', gap: 8 }}>
                {MODE_ORDER.map((m) => (
                  <button
                    key={m}
                    onClick={() => setSelectedMode(m)}
                    className={selectedMode === m ? 'tab-btn active' : 'tab-btn'}
                    style={{ fontSize: 13, justifyContent: 'center', color: selectedMode === m ? 'var(--color-primary)' : 'var(--color-text-muted)' }}
                  >
                    <TabLabel>{modeLabel(m)}</TabLabel>
                  </button>
                ))}
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                {MODE_ORDER.map((m) => {
                  const r = getPeerRun(m);
                  return r ? (
                    <button
                      key={m}
                      className="tab-btn"
                      onClick={() => handleDownload(r._id)}
                      disabled={!!downloading}
                      title={`Download ${modeLabel(m)}`}
                      style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                    >
                      <img src="/icon-download.png" alt="" style={{ width: 13, height: 13, objectFit: 'contain', opacity: 0.7 }} />
                      {downloading === r._id ? 'Downloading…' : modeLabel(m)}
                    </button>
                  ) : null;
                })}
              </div>
            </div>
            {loadingRun ? (
              <p style={{ color: 'var(--color-text-muted)' }}>Loading results&hellip;</p>
            ) : fullRun ? (
              <ResultsPanel run={fullRun} cohortId={cohortId} cycleId={cycleId} />
            ) : (
              <p style={{ color: 'var(--color-text-muted)' }}>Select a run to view results.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DownloadsTab — download Excel for each run/mode
// ---------------------------------------------------------------------------
function DownloadsTab() {
  const [cohorts, setCohorts]   = useState([]);
  const [cohortId, setCohortId] = useState('');
  const [runs, setRuns]         = useState([]);
  const [loading, setLoading]   = useState(false);
  const [downloading, setDownloading] = useState(''); // runId being downloaded

  useEffect(() => { getCohorts().then((r) => setCohorts(r.data ?? [])).catch(() => {}); }, []);

  const loadRuns = useCallback(() => {
    if (!cohortId) return;
    setLoading(true);
    getAlgorithmRuns({ cohortId, limit: 50 })
      .then((r) => setRuns((r.data?.runs ?? []).filter((x) => x.status === 'completed')))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [cohortId]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const handleDownload = async (runId) => {
    if (downloading) return;
    setDownloading(runId);
    try {
      const res = await api.get(`/api/admin/algorithm/runs/${runId}/download`, { responseType: 'blob', timeout: 180000 });
      const disposition = res.headers['content-disposition'] ?? '';
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
      const filename = filenameMatch?.[1] ?? `zlp-run-${runId}.xlsx`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      alert('Download failed. Please try again.');
    } finally {
      setDownloading('');
    }
  };

  // Group by batch (created within 30s) — up to 3 mode runs per invocation
  const pairs = [];
  const seen = new Set();
  for (const r of runs) {
    if (seen.has(r._id)) continue;
    const members = runs
      .filter((x) => !seen.has(x._id) && Math.abs(new Date(x.createdAt) - new Date(r.createdAt)) < 30000)
      .sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode));
    members.forEach((x) => seen.add(x._id));
    pairs.push({ runs: members });
  }

  return (
    <div>
      <div className="form-group" style={{ maxWidth: 280, marginBottom: 20 }}>
        <label>Cohort</label>
        <select value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
          <option value="">Select cohort</option>
          {cohorts.map((c) => <option key={c._id} value={c._id}>{'  '}{c.name}</option>)}
        </select>
      </div>

      {loading && <p style={{ color: 'var(--color-text-muted)' }}>Loading&hellip;</p>}

      {!loading && cohortId && pairs.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-muted)' }}>
          No completed runs found for this cohort.
        </div>
      )}

      {pairs.map(({ runs: pairRuns }) => {
        const anchor = pairRuns[0];
        return (
          <div key={anchor._id} className="card" style={{ marginBottom: 16, padding: '14px 18px' }}>
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>
              Run &mdash; {new Date(anchor.createdAt).toLocaleString()}
              <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 400 }}>
                {anchor.summary?.totalStudents ?? '?'} students &middot; {anchor.parameters?.termCode ?? ''}{anchor.parameters?.includeDraftSubmissions ? ' (incl. drafts)' : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {pairRuns.map((r) => (
                <button
                  key={r._id}
                  className="btn-secondary"
                  onClick={() => handleDownload(r._id)}
                  disabled={downloading === r._id}
                  style={{ padding: '8px 16px', fontSize: 13 }}
                >
                  {downloading === r._id ? 'Downloading\u2026' : `📄 ${modeLabel(r.mode)}`}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Post-run panel — shown immediately after running
// ---------------------------------------------------------------------------
function PostRunPanel({ result, onViewResults }) {
  const [mode, setMode] = useState('required_only');
  const runsByMode = {
    required_only:            result?.requiredOnlyRun,
    preferred:                result?.preferredRun,
    required_plus_preferred:  result?.requiredPlusPreferredRun,
  };
  const run = runsByMode[mode];

  return (
    <div>
      <div className="alert alert-info" style={{ marginBottom: 20 }}>
        &#10003; Algorithm completed successfully. Results are saved and available in the Results tab.
      </div>
      <div style={{ display: 'inline-grid', gridAutoFlow: 'column', gridAutoColumns: '1fr', gap: 8, marginBottom: 16, paddingBottom: 4, borderBottom: '1px solid var(--color-border, #e5e7eb)' }}>
        {MODE_ORDER.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={mode === m ? 'tab-btn active' : 'tab-btn'}
            style={{ fontSize: 13, justifyContent: 'center', color: mode === m ? 'var(--color-primary)' : 'var(--color-text-muted)' }}
          >
            <TabLabel>{modeLabel(m)}</TabLabel>
          </button>
        ))}
      </div>
      {run && (
        <>
          <RunSummaryCards run={run} />
          {run.warnings?.length > 0 && (
            <div className="alert alert-warn" style={{ marginBottom: 12 }}>
              <strong>{run.warnings.length} warning(s):</strong>
              <ul style={{ margin: '6px 0 0 16px', fontSize: 12 }}>
                {run.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
          {run.status === 'failed' && (
            <div className="alert alert-error">Run failed: {run.errorMessage}</div>
          )}
        </>
      )}
      <button className="btn-secondary" onClick={onViewResults} style={{ marginTop: 8 }}>
        View Full Results &rarr;
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main AdminAlgorithm page
// ---------------------------------------------------------------------------
export default function AdminAlgorithm() {
  const [tab, setTab]         = useState('run');
  const [lastResult, setLastResult] = useState(null);
  const [lastRunCohortId,  setLastRunCohortId]  = useState(null);
  const [lastRunCycleId,   setLastRunCycleId]   = useState(null);

  const handleRunComplete = (result, cohortId, cycleId) => {
    setLastResult(result);
    setLastRunCohortId(cohortId ?? null);
    setLastRunCycleId(cycleId ?? null);
    setTab('results');
  };

  const TABS = [
    { key: 'run',     label: null, icon: '/icon-algorithm.png',     text: 'Run' },
    { key: 'results', label: null, icon: '/icon-monitor-graph.png', text: 'Results' },
  ];

  return (
    <div className="algorithm-page" style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
      <div className="page-header">
        <h1>ZLP Scheduling Algorithm</h1>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, paddingBottom: 8, borderBottom: '1px solid var(--color-border, #e5e7eb)' }}>
        {TABS.map(({ key, icon, text }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={tab === key ? 'tab-btn active' : 'tab-btn'}
            style={{ color: tab === key ? '#3b82f6' : 'var(--color-text-muted)' }}
          >
            <img src={icon} alt="" style={{ width: 15, height: 15, objectFit: 'contain', opacity: 0.75 }} />
            {text}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'run' && (
        <RunTab onRunComplete={handleRunComplete} />
      )}
      {tab === 'results' && (
        <ResultsTab
          jumpToRunId={lastResult ? (lastResult.requiredOnlyRun?._id ?? lastResult.preferredRun?._id ?? lastResult.requiredPlusPreferredRun?._id) : null}
          jumpCohortId={lastRunCohortId}
          jumpCycleId={lastRunCycleId}
        />
      )}
    </div>
  );
}
