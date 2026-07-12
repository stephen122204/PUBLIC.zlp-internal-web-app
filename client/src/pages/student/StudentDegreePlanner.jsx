import { useState, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import {
  getStudentAcademicProfile, saveStudentAcademicProfile,
  getDegreePlanSelection, saveDegreePlanSelection,
  getStudentSemesterPlan, saveStudentSemesterPlan,
  getStudentTermOptions,
  confirmDegreePlanImport,
  getDegreeGraph,
  getCoursesBySubject,
  getCourseSubjects,
} from '../../api';
import AcademicProfileEditor from '../../components/AcademicProfileEditor';
import { computeSemesterCreditHours } from '../../lib/degreePlanEvaluation';
import { parseTranscriptFile } from '../../lib/transcriptPdfParser';

// TAMU transfer-credit grades. A course is transfer credit iff its grade is one
// of these — the transcript's section heading is NOT used (it mis-sections on
// some PDFs and would flag every course as transfer).
const TRANSFER_GRADES = new Set(['TA', 'TB', 'TC', 'TD', 'TR', 'TCR']);

function newCourse(status = 'planned') {
  return {
    _key: Math.random().toString(36).slice(2),
    subject: '', number: '', code: '', title: '', creditHours: '',
    honors: false, transfer: false,
    status, notes: '',
  };
}

// Research / variable-credit courses at TAMU — number ends in 84, 85, 91, 92, or 99
// (e.g. 484, 685, 491, 691, 399, 499, 699). Students can freely edit hours (0–6).
function isResearchCourse(number) {
  // Only 400-level and above ending in 84/85/91/92/99 are variable-credit research courses.
  // This prevents 199, 299, 399 etc. from being treated as research.
  return typeof number === 'string' && /[4-9](8[45]|9[129])$/.test(number.trim());
}

// Returns true only for courses whose credit hours are genuinely variable and should
// remain editable. High Impact Experience 0-hr courses and KINE 199 are fixed.
function isVariableHoursCourse(number) {
  if (!number || typeof number !== 'string') return false;
  const n = number.trim().toUpperCase();
  // KINE 199 is a fixed 0-hr course
  if (n === 'KINE 199') return false;
  // Research courses (ends in 84x, 85x, 91x, 92x, 99x) are variable
  return isResearchCourse(n);
}

function newSemester(orderIndex) {
  return {
    _key: Math.random().toString(36).slice(2),
    label: '', year: null, term: 'Fall', termCode: '',
    orderIndex, status: 'planned', notes: '',
    courses: [newCourse('planned')],
  };
}

function statusLabel(s) {
  if (s === 'completed') return 'Completed';
  if (s === 'in_progress') return 'In Progress';
  return 'Planned';
}

function statusBadgeStyle(s) {
  if (s === 'completed')  return { background: '#d1fae5', color: '#065f46', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700, fontStyle: 'italic' };
  if (s === 'in_progress') return { background: '#dbeafe', color: '#1e40af', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 400, fontStyle: 'italic' };
  return { background: 'transparent', color: '#374151', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 400, fontStyle: 'italic' };
}

// Shared subjects cache so every CourseRow doesn't refetch independently
let _subjectsCache = null;
let _subjectsFetch = null;
function getSubjectsOnce() {
  if (_subjectsCache) return Promise.resolve(_subjectsCache);
  if (!_subjectsFetch) {
    _subjectsFetch = getCourseSubjects()
      .then((r) => { _subjectsCache = r.data.subjects ?? []; return _subjectsCache; })
      .catch(() => []);
  }
  return _subjectsFetch;
}

function CourseRow({ course, onChange, onRemove }) {
  const [subjects, setSubjects]           = useState([]);
  const [subjectQuery, setSubjectQuery]   = useState(course.subject ?? '');
  const [subjectOpen, setSubjectOpen]     = useState(false);
  const [courses, setCourses]             = useState([]);
  const [coursesLoading, setCoursesLoading] = useState(false);
  const [courseQuery, setCourseQuery]     = useState(course.number ?? '');
  const [courseOpen, setCourseOpen]       = useState(false);
  const subjectRef = useRef(null);
  const courseRef  = useRef(null);

  // Keep local query inputs in sync when course prop changes externally
  useEffect(() => { setSubjectQuery(course.subject ?? ''); }, [course.subject]);
  useEffect(() => { setCourseQuery(course.number ?? ''); }, [course.number]);

  useEffect(() => { getSubjectsOnce().then(setSubjects); }, []);

  useEffect(() => {
    if (!course.subject) { setCourses([]); return; }
    setCoursesLoading(true);
    getCoursesBySubject({ subject: course.subject })
      .then((r) => setCourses(r.data.courses ?? []))
      .catch(() => setCourses([]))
      .finally(() => setCoursesLoading(false));
  }, [course.subject]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-populate title/hours when the catalog courses list loads and the saved row
  // is missing that data. Only call onChange when the values would genuinely change —
  // calling it unconditionally fires setIsDirty(true) even on the initial page load.
  useEffect(() => {
    if (!course.number || !courses.length) return;
    const match = courses.find((c) => c.courseNumber === course.number);
    if (!match) return;
    const updates = {};
    if (!course.title && match.title && match.title !== course.title) updates.title = match.title;
    if (course.creditHours == null && match.creditHours != null) updates.creditHours = match.creditHours;
    if (Object.keys(updates).length > 0) onChange({ ...course, ...updates });
  }, [courses, course.number]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handle(e) {
      if (subjectRef.current && !subjectRef.current.contains(e.target)) setSubjectOpen(false);
      if (courseRef.current  && !courseRef.current.contains(e.target))  setCourseOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const filteredSubjects = subjectQuery
    ? subjects.filter((s) => s.startsWith(subjectQuery.toUpperCase()))
    : subjects;

  const filteredCourses = courseQuery
    ? courses.filter((c) => c.courseNumber.includes(courseQuery) || c.title.toLowerCase().includes(courseQuery.toLowerCase()))
    : courses;

  function pickSubject(subj) {
    setSubjectQuery(subj);
    setSubjectOpen(false);
    setCourseQuery('');
    onChange({ ...course, subject: subj, number: '', code: subj, title: '' });
  }

  function pickCourse(c) {
    setCourseQuery(c.courseNumber);
    setCourseOpen(false);
    onChange({
      ...course,
      number: c.courseNumber,
      code: `${course.subject} ${c.courseNumber}`,
      title: c.title,
      creditHours: c.creditHours != null ? c.creditHours : (course.creditHours || ''),
    });
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}>

      {/* Subject typeahead */}
      <div ref={subjectRef} style={{ position: 'relative', width: 60 }}>
        <input
          value={subjectQuery}
          onChange={(e) => {
            const v = e.target.value.toUpperCase();
            setSubjectQuery(v); setSubjectOpen(true);
            if (v !== course.subject) onChange({ ...course, subject: '', number: '', code: '', title: '' });
          }}
          onFocus={() => setSubjectOpen(true)}
          placeholder="SUBJ" style={{ width: '100%', fontSize: 13, textAlign: 'center' }} maxLength={5} autoComplete="off"
        />
        {subjectOpen && filteredSubjects.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 300,
            background: 'var(--color-surface, #fff)', border: '1px solid var(--color-border)',
            borderRadius: 4, maxHeight: 180, overflowY: 'auto', minWidth: 80, boxShadow: '0 4px 12px rgba(0,0,0,.12)',
          }}>
            {filteredSubjects.map((s) => (
              <div key={s} onMouseDown={() => pickSubject(s)} style={{
                padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'monospace',
                background: s === course.subject ? 'var(--color-primary-light,#eef2ff)' : 'transparent',
              }}>{s}</div>
            ))}
          </div>
        )}
      </div>

      {/* Course number dropdown */}
      <div ref={courseRef} style={{ position: 'relative', width: 52 }}>
        <input
          value={courseQuery}
          onChange={(e) => { setCourseQuery(e.target.value); setCourseOpen(true); }}
          onFocus={() => { if (course.subject) setCourseOpen(true); }}
          placeholder={course.subject ? (coursesLoading ? '…' : '000') : '—'}
          disabled={!course.subject}
          style={{ width: '100%', fontSize: 13, textAlign: 'center' }} maxLength={4} autoComplete="off"
        />
        {courseOpen && filteredCourses.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 300,
            background: 'var(--color-surface, #fff)', border: '1px solid var(--color-border)',
            borderRadius: 4, maxHeight: 220, overflowY: 'auto', minWidth: 260, boxShadow: '0 4px 12px rgba(0,0,0,.12)',
          }}>
            {filteredCourses.map((c) => (
              <div key={c.courseNumber} onMouseDown={() => pickCourse(c)} style={{
                padding: '4px 10px', fontSize: 12, cursor: 'pointer', display: 'flex', gap: 8,
                background: course.number === c.courseNumber ? 'var(--color-primary-light,#eef2ff)' : 'transparent',
              }}>
                <span style={{ fontFamily: 'monospace', fontWeight: 600, minWidth: 38 }}>{c.courseNumber}</span>
                <span style={{ color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Title — auto-populated from catalog when number is selected, read-only */}
      <input
        value={course.title}
        onChange={(e) => onChange({ ...course, title: e.target.value })}
        readOnly={!!course.number}
        tabIndex={course.number ? -1 : 0}
        placeholder="Auto-populated from catalog"
        style={{ flex: '1 1 160px', minWidth: 120, fontSize: 13, background: course.number ? 'var(--color-bg-muted,#f9fafb)' : undefined, color: course.number ? 'var(--color-text-muted)' : undefined, cursor: course.number ? 'default' : undefined }}
        maxLength={200}
      />

      <input
        value={course.creditHours ?? ''}
        onChange={(e) => {
          if (!!course.number && !isVariableHoursCourse(course.number)) return;
          onChange({ ...course, creditHours: e.target.value === '' ? '' : Number(e.target.value) });
        }}
        onKeyDown={(e) => { if (!!course.number && !isVariableHoursCourse(course.number)) e.preventDefault(); }}
        onMouseDown={(e) => { if (!!course.number && !isVariableHoursCourse(course.number)) e.preventDefault(); }}
        readOnly={!!course.number && !isVariableHoursCourse(course.number)}
        tabIndex={!!course.number && !isVariableHoursCourse(course.number) ? -1 : 0}
        placeholder="Hrs" type="number" min={0} max={isVariableHoursCourse(course.number) ? 6 : 20}
        style={{ width: 36, fontSize: 13, textAlign: 'center',
          background: (!!course.number && !isVariableHoursCourse(course.number)) ? 'var(--color-bg-muted,#f9fafb)' : undefined,
          cursor: (!!course.number && !isVariableHoursCourse(course.number)) ? 'default' : undefined }}
      />
      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 3, width: 60, flexShrink: 0 }}>
        <input type="checkbox" checked={course.honors} onChange={(e) => onChange({ ...course, honors: e.target.checked })} /> Honors
      </label>
      <label
        style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 3, width: 68, flexShrink: 0 }}
        title="Transfer credit (e.g. TA, TB, TCR). Informational only — does not affect classification."
      >
        <input type="checkbox" checked={!!course.transfer} onChange={(e) => onChange({ ...course, transfer: e.target.checked })} /> Transfer
      </label>
      <button
        type="button" onClick={onRemove}
        style={{ background: 'none', border: 'none', color: 'var(--color-error,#c00)', cursor: 'pointer', fontSize: 16, padding: '0 4px', width: 20, flexShrink: 0 }}
        title="Remove"
      >&times;</button>
    </div>
  );
}

/**
 * Filter term options to only show semesters from the student's catalog year
 * (inclusive) through Spring of (catalogYear + 5 years).
 * If no catalog year is known, returns the full list unchanged.
 * Terms that are already on a saved semester but fall outside this range are
 * preserved separately in SemesterCard via the existing out-of-list fallback.
 */
function getFilteredTermOptions(termOptions, effectiveCatalogYear) {
  if (!effectiveCatalogYear || !termOptions.length) return termOptions;
  const SEASON_CODES = { Fall: '31', Summer: '21', Spring: '11' };
  const m = effectiveCatalogYear.match(/^(Fall|Spring|Summer)\s+(\d{4})$/);
  if (!m) return termOptions;
  const season = m[1];
  const startYear = parseInt(m[2], 10);
  const minCode = parseInt(`${startYear}${SEASON_CODES[season]}`, 10);
  const maxCode = parseInt(`${startYear + 5}11`, 10); // Spring of startYear+5
  return termOptions.filter((t) => {
    const code = parseInt(t.termCode, 10);
    return code >= minCode && code <= maxCode;
  });
}

function SemesterCard({ semester, termOptions = [], onChange, onRemove, expanded, onToggle }) {
  const totalHrs = computeSemesterCreditHours({
    ...semester,
    courses: semester.courses.map((c) => ({ ...c, creditHours: Number(c.creditHours) || 0 })),
  });

  function updateCourse(idx, updated) {
    const cs = [...semester.courses];
    cs[idx] = updated;
    onChange({ ...semester, courses: cs });
  }
  function removeCourse(idx) {
    onChange({ ...semester, courses: semester.courses.filter((_, i) => i !== idx) });
  }
  function addCourse() {
    onChange({ ...semester, courses: [...semester.courses, newCourse(semester.status)] });
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', cursor: 'pointer' }}
        onClick={onToggle}
      >
        <span style={statusBadgeStyle(semester.status)}>{statusLabel(semester.status)}</span>
        <span style={{ fontWeight: 700, fontSize: 16 }}>{semester.label || 'Unnamed Semester'}</span>
        <span style={{ fontSize: 13, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
          {totalHrs > 0 ? `${totalHrs} hrs \u00b7 ` : ''}{semester.courses.length} course{semester.courses.length !== 1 ? 's' : ''}
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{expanded ? '\u25b2' : '\u25bc'}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 2 }}>Semester</label>
              <select
                value={semester.termCode ?? ''}
                onChange={(e) => {
                  const opt = termOptions.find((t) => t.termCode === e.target.value);
                  if (!opt) {
                    // Cleared — keep existing label but blank termCode
                    onChange({ ...semester, termCode: '' });
                    return;
                  }
                  const m = opt.term.match(/^(Fall|Spring|Summer)(.*)(\d{4})/);
                  const season = m?.[1] ?? 'Other';
                  const year   = m ? parseInt(m[3], 10) : null;
                  onChange({ ...semester, termCode: opt.termCode, term: season, year, label: opt.term });
                }}
                style={{ fontSize: 13 }}
              >
                <option value="">{semester.termCode ? '— clear —' : '— select semester —'}</option>
                {termOptions.map((t) => (
                  <option key={t.termCode} value={t.termCode}>{t.term}</option>
                ))}
                {/* If the current termCode isn't in the list (old transcript semester), show it */}
                {semester.termCode && !termOptions.find((t) => t.termCode === semester.termCode) && (
                  <option value={semester.termCode}>{semester.label || semester.termCode}</option>
                )}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 2 }}>Status</label>
              <select value={semester.status} onChange={(e) => onChange({ ...semester, status: e.target.value })} style={{ fontSize: 13 }}>
                <option value="completed">Completed</option>
                <option value="in_progress">In Progress</option>
                <option value="planned">Planned</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, padding: '4px 0', borderBottom: '2px solid var(--color-border)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', flexWrap: 'wrap' }}>
            <span style={{ width: 60, flexShrink: 0 }}>Subject</span>
            <span style={{ width: 52, flexShrink: 0 }}>Number</span>
            <span style={{ flex: '1 1 160px', minWidth: 120 }}>Title</span>
            <span style={{ width: 36, flexShrink: 0 }}>Hrs</span>
            <span style={{ width: 60, flexShrink: 0 }}>Honors</span>
            <span style={{ width: 68, flexShrink: 0 }}>Transfer</span>
            <span style={{ width: 20, flexShrink: 0 }} />
          </div>

          {semester.courses.map((c, idx) => (
            <CourseRow
              key={c.id ?? c._key ?? idx}
              course={c}
              onChange={(u) => updateCourse(idx, u)}
              onRemove={() => removeCourse(idx)}
            />
          ))}

          {totalHrs > 0 && (
            <div style={{ textAlign: 'right', fontSize: 13, color: 'var(--color-primary,#1a56db)', fontWeight: 700, marginTop: 6 }}>
              Total: {totalHrs} credit hrs
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn-secondary btn-sm" onClick={addCourse} title="Add Course" style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>+</button>
            <button
              type="button" className="btn-secondary btn-sm"
              style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 700, lineHeight: 1, color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
              onClick={onRemove}
              title="Remove Semester"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function transcriptToSemesters(parsed, catalogMap, termOptions = []) {
  const termMap = new Map();
  const seasonRank = { Spring: 1, Summer: 2, Fall: 3, Other: 4 };

  // Build a quick lookup: "Fall 2023" -> termCode, tolerating description suffixes
  function matchTermCode(label) {
    if (!label || !termOptions.length) return '';
    const exact = termOptions.find((t) => t.term === label);
    if (exact) return exact.termCode;
    const prefix = termOptions.find((t) => t.term.startsWith(label + ' ') || t.term.startsWith(label + ','));
    return prefix?.termCode ?? '';
  }

  for (const course of parsed.courses ?? []) {
    // Skip TRNS XXX placeholder entries — these are institutional cross-reference records,
    // not real courses (e.g. "TRNS XXX MATH180-ANALY GEOM/CALC I TA 1.000 0.000").
    if (course.subject === 'TRNS') continue;

    const m = course.term?.match(/^(Fall|Spring|Summer) (\d{4})/);
    const season = m?.[1] ?? 'Other';
    const year   = m?.[2] ? parseInt(m[2], 10) : null;
    const key    = `${year ?? '?'}-${season}`;
    if (!termMap.has(key)) termMap.set(key, { season, year, courses: [], hasInProgress: false, byCourseCode: new Map() });
    const grp = termMap.get(key);
    if (course.status === 'in-progress') grp.hasInProgress = true;

    // Deduplicate by code within the same term — keep whichever entry has more data
    // (longer title, or credits present). This handles row vs column parser double-picks.
    const existing = grp.byCourseCode.get(course.code);
    if (existing) {
      const score = (c) => String(c.title ?? '').length + Number(c.credits != null);
      if (score(course) > score(existing)) {
        grp.courses[grp.courses.indexOf(existing)] = course;
        grp.byCourseCode.set(course.code, course);
      }
    } else {
      grp.byCourseCode.set(course.code, course);
      grp.courses.push(course);
    }
  }

  return [...termMap.entries()]
    .sort(([, a], [, b]) => {
      const dy = (a.year ?? 9999) - (b.year ?? 9999);
      return dy !== 0 ? dy : (seasonRank[a.season] ?? 4) - (seasonRank[b.season] ?? 4);
    })
    .map(([, grp], i) => {
      const label = `${grp.season} ${grp.year ?? ''}`.trim();
      return ({
      _key: Math.random().toString(36).slice(2),
      label,
      year: grp.year,
      term: ['Fall', 'Spring', 'Summer'].includes(grp.season) ? grp.season : 'Other',
      termCode: matchTermCode(label),
      orderIndex: i,
      status: grp.hasInProgress ? 'in_progress' : 'completed',
      notes: '',
        courses: grp.courses.map((c) => {
        const isInProgress = c.status === 'in-progress';
        // Grades that did NOT complete the course — skip them entirely so they
        // never land in the completed section: failed (F/U), Q-dropped (Q),
        // withdrawn (W), and incomplete (I). D counts as a pass. If a course was
        // failed then retaken, only the passing attempt populates.
        const NOT_COMPLETED = new Set(['F', 'U', 'Q', 'W', 'I']);
        // Validate subject (2-5 uppercase letters) and number (3 digits + optional letter).
        // Skip anything that doesn't match — these are noise rows from the PDF.
        if (!/^[A-Z]{2,5}$/.test(c.subject) || !/^\d{3}[A-Z]?$/.test(c.number)) return null;
        if (!isInProgress) {
          if (!c.grade || NOT_COMPLETED.has(c.grade)) return null;
        }
        return {
          _key: Math.random().toString(36).slice(2),
          subject: c.subject,
          number: c.number,
          code: c.code,
          title: catalogMap?.get(c.code)?.title ?? '',
          creditHours: (() => { const ch = catalogMap?.get(c.code)?.creditHours ?? null; return (ch != null && ch > 0) ? ch : (c.credits || ''); })(),
          honors: false,
          // Transfer credit — flagged only by a transfer grade (TA, TB, TC, TR,
          // TCR). Informational only.
          transfer: TRANSFER_GRADES.has(c.grade),
          status: isInProgress ? 'in_progress' : 'completed',
          notes: '',
          source: 'transcript_import',
        };
      }).filter(Boolean),
    });
    });
}

function TranscriptImportModal({ parsed, termOptions, onClose, onConfirm }) {
  useEscapeKey(onClose);
  const semesters = transcriptToSemesters(parsed, parsed.catalogMap, termOptions);
  const totalCourses = semesters.reduce((n, s) => n + s.courses.length, 0);
  const grandTotal = semesters.reduce((sum, s) =>
    sum + s.courses.reduce((ss, c) => ss + (c.creditHours != null && c.creditHours !== '' ? Number(c.creditHours) : 0), 0)
  , 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        <h2 style={{ marginBottom: 6 }}>Transcript Import Preview</h2>

        {parsed.studentName && (
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            <strong>{parsed.studentName.split(/\s+/).filter((p) => !/^[A-Z]\.?$/i.test(p)).join(' ')}</strong>
            {parsed.earnedHours != null && (
              <span style={{ color: 'var(--color-text-muted)', marginLeft: 10 }}>{parsed.earnedHours} earned hrs</span>
            )}
          </div>
        )}

        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 10 }}>
          {semesters.length} semester{semesters.length !== 1 ? 's' : ''} &middot; {totalCourses} course{totalCourses !== 1 ? 's' : ''}.
          Importing will <strong>replace</strong> your current semester plan.
        </div>

        <div style={{ overflowY: 'auto', flex: 1, border: '1px solid var(--color-border)', borderRadius: 6, padding: 8 }}>
          {semesters.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>No courses found in this PDF.</div>
          ) : (
            <>
              {semesters.map((sem, si) => {
                const semHrs = sem.courses.reduce((ss, c) =>
                  ss + (c.creditHours != null && c.creditHours !== '' ? Number(c.creditHours) : 0), 0);
                return (
                  <div key={si} style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{sem.label}</span>
                      {sem.termCode && <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 400 }}>({sem.termCode})</span>}
                      <span style={{ ...statusBadgeStyle(sem.status), marginLeft: 4 }}>{statusLabel(sem.status)}</span>
                      {semHrs > 0 && (
                        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-primary,#1a56db)', fontWeight: 700 }}>
                          {semHrs} hr{semHrs !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    {sem.courses.map((c, ci) => (
                      <div key={ci} style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 8, alignItems: 'center' }}>
                        <strong style={{ minWidth: 90 }}>{c.code}</strong>
                        <span style={{ flex: 1, color: 'var(--color-text-muted)' }}>{c.title && c.title !== c.code ? c.title : ''}</span>
                        <span style={{ minWidth: 36, textAlign: 'right', color: c.creditHours != null && c.creditHours !== '' ? 'var(--color-text)' : 'var(--color-text-muted)', fontWeight: c.creditHours != null && c.creditHours !== '' ? 600 : 400 }}>
                          {c.creditHours != null && c.creditHours !== '' ? `${c.creditHours} hr${c.creditHours !== 1 ? 's' : ''}` : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })}
              {grandTotal > 0 && (
                <div style={{ borderTop: '2px solid var(--color-border)', marginTop: 4, paddingTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--color-primary,#1a56db)' }}>
                    Grand Total: {grandTotal} credit hr{grandTotal !== 1 ? 's' : ''}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn-primary" onClick={() => onConfirm(semesters)} disabled={semesters.length === 0}>
            Import Plan
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function StudentDegreePlanner() {
  const [termOptions, setTermOptions]                = useState([]);
  const [academicProfile, setAcademicProfile]       = useState(null);
  const [cohortCatalogYear, setCohortCatalogYear]    = useState(null);
  const [effectiveCatalogYear, setEffectiveCatalogYear] = useState(null);
  const [catalogYearSource, setCatalogYearSource]    = useState('cohort_default');
  const [profileLoading, setProfileLoading]          = useState(true);
  const [profileSaving, setProfileSaving]            = useState(false);
  const [graph, setGraph]                            = useState(null);
  const [graphLoading, setGraphLoading]              = useState(false);
  const [semesters, setSemesters]                    = useState([]);
  const [planLoading, setPlanLoading]                = useState(true);
  const [planSaving, setPlanSaving]                  = useState(false);
  const [planSaveError, setPlanSaveError]            = useState(null);
  const [toast, setToast]                            = useState({ msg: null, type: 'success' });
  const [expandedSems, setExpandedSems]              = useState(new Set());
  const [showTranscriptImport, setShowTranscriptImport] = useState(false);
  const [transcriptParsed, setTranscriptParsed]        = useState(null);
  const [transcriptLoading, setTranscriptLoading]      = useState(false);
  const [transcriptError, setTranscriptError]          = useState('');
  const [isDirty, setIsDirty]                          = useState(false);

  const toastTimerRef = useRef(null);

  // Block in-app navigation when there are unsaved changes
  const blocker = useBlocker(isDirty);

  // Block browser tab / window close when there are unsaved changes
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  useEffect(() => {
    getStudentTermOptions().then((r) => setTermOptions(r.data.terms ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [profRes, planRes] = await Promise.all([
          getStudentAcademicProfile().catch(() => ({ data: { profile: null } })),
          getStudentSemesterPlan().catch(() => ({ data: { semesters: [] } })),
        ]);
        if (!mounted) return;
        const prof = profRes.data.profile ?? null;
        setAcademicProfile(prof);
        setCohortCatalogYear(profRes.data.cohortCatalogYear ?? null);
        setEffectiveCatalogYear(profRes.data.effectiveCatalogYear ?? profRes.data.cohortCatalogYear ?? null);
        setCatalogYearSource(profRes.data.catalogYearSource ?? 'cohort_default');
        const loaded = (planRes.data.semesters ?? []).map((s) => ({
          ...s,
          _key: s.id,
          courses: (s.courses ?? []).map((c) => ({ ...c, _key: c.id })),
        }));
        setSemesters(loaded);
        // Auto-expand the most recent (last) semester so the student lands on their
        // latest upcoming coursework rather than having to expand it manually.
        const lastKey = loaded.length > 0 ? (loaded[loaded.length - 1]._key ?? loaded[loaded.length - 1].id) : null;
        setExpandedSems(lastKey ? new Set([lastKey]) : new Set());
        const programId = prof?.primaryMajor?.programId ?? null;
        if (programId) loadGraph(programId);
      } finally {
        if (mounted) { setProfileLoading(false); setPlanLoading(false); }
      }
    }
    load();
    return () => { mounted = false; };
  }, []);
  async function loadGraph(programId) {
    if (!programId) { setGraph(null); return; }
    setGraphLoading(true);
    try {
      const { data } = await getDegreeGraph(programId);
      setGraph(data.graph);
    } catch {
      setGraph(null);
    } finally {
      setGraphLoading(false);
    }
  }

  function showToast(msg, type = 'success') {
    clearTimeout(toastTimerRef.current);
    setToast({ msg, type });
    toastTimerRef.current = setTimeout(() => setToast({ msg: null, type: 'success' }), type === 'error' ? 5000 : 2500);
  }

  async function handleSaveProfile(data) {
    setProfileSaving(true);
    try {
      const res  = await saveStudentAcademicProfile(data);
      const prof = res.data.profile;
      setAcademicProfile(prof);
      setCohortCatalogYear(res.data.cohortCatalogYear ?? null);
      setEffectiveCatalogYear(res.data.effectiveCatalogYear ?? res.data.cohortCatalogYear ?? null);
      setCatalogYearSource(res.data.catalogYearSource ?? 'cohort_default');
      showToast('Profile saved!');
      const programId = prof?.primaryMajor?.programId ?? null;
      await saveDegreePlanSelection(programId ?? '').catch(() => {});
      loadGraph(programId);
    } catch (err) {
      showToast(err?.response?.data?.error ?? 'Failed to save. Are you enrolled in a cohort?', 'error');
    } finally {
      setProfileSaving(false);
    }
  }

  function updateSemester(key, updated) {
    setSemesters((p) => p.map((s) => (s._key === key ? updated : s)));
    setIsDirty(true);
  }
  function removeSemester(key) {
    setSemesters((p) => p.filter((s) => s._key !== key));
    setIsDirty(true);
  }
  function addSemester() {
    const s = newSemester(semesters.length);
    setSemesters((p) => [...p, s]);
    setExpandedSems((p) => new Set([...p, s._key]));
    setIsDirty(true);
  }
  function toggleExpand(key) {
    setExpandedSems((p) => {
      const n = new Set(p);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }
  function expandAll() {
    setExpandedSems(new Set(semesters.map((s) => s._key ?? s.id)));
  }
  function collapseAll() {
    setExpandedSems(new Set());
  }
  const allExpanded = semesters.length > 0 && semesters.every((s) => expandedSems.has(s._key ?? s.id));

  async function handleDeletePlan() {
    if (!window.confirm('Delete the entire semester plan? This cannot be undone.')) return;
    setSemesters([]);
    setExpandedSems(new Set());
    setPlanSaving(true); setPlanSaveError(null);
    try {
      await saveStudentSemesterPlan([]);
      showToast('Plan deleted.');
      setIsDirty(false);
    } catch (err) {
      setPlanSaveError(err?.response?.data?.error ?? 'Failed to delete plan.');
    } finally {
      setPlanSaving(false);
    }
  }

  async function handleSavePlan() {
    setPlanSaving(true); setPlanSaveError(null);
    try {
      const payload = semesters.map((s, i) => ({
        label: s.label || `Semester ${i + 1}`,
        year: s.year ?? null,
        term: ['Fall', 'Spring', 'Summer', 'Other'].includes(s.term) ? s.term : 'Other',
        termCode: s.termCode ?? '',
        orderIndex: i,
        status: s.status,
        notes: s.notes ?? '',
        courses: (s.courses ?? [])
          .filter((c) => c.subject && c.number)
          .map((c) => ({
            subject: c.subject.toUpperCase(),
            number: c.number.toUpperCase(),
            code: `${c.subject.toUpperCase()} ${c.number.toUpperCase()}`,
            title: c.title ?? '',
            creditHours: c.creditHours !== '' && c.creditHours != null ? Number(c.creditHours) : null,
            status: ['completed', 'in_progress', 'planned'].includes(c.status) ? c.status : s.status,
            honors: !!c.honors,
            transfer: !!c.transfer,
            source: c.source ?? 'manual',
            notes: c.notes ?? '',
          })),
      }));
      const { data } = await saveStudentSemesterPlan(payload);
      // Merge server IDs back in but preserve local _key values so React doesn't
      // unmount/remount SemesterCards, which would reset scroll position and collapse
      // expanded semesters. The local _key is stable for the lifetime of the session.
      const saved = (data.semesters ?? []).map((serverSem, i) => {
        const local = semesters[i];
        return {
          ...serverSem,
          _key: local?._key ?? serverSem.id,
          courses: (serverSem.courses ?? []).map((c, ci) => ({
            ...c,
            _key: local?.courses?.[ci]?._key ?? c.id,
          })),
        };
      });
      setSemesters(saved);
      showToast('Plan saved!');
      setIsDirty(false);
    } catch (err) {
      setPlanSaveError(err?.response?.data?.error ?? 'Failed to save plan.');
    } finally {
      setPlanSaving(false);
    }
  }

  async function handleTranscriptFile(file) {
    setTranscriptLoading(true); setTranscriptError(''); setTranscriptParsed(null);
    try {
      const result = await parseTranscriptFile(file);

      // Enrich with catalog titles: fetch all unique subjects in parallel, then build
      // a lookup map { "CSCE 181": { title } } keyed by normalized course code.
      const subjects = [...new Set(
        (result.courses ?? []).map((c) => c.subject).filter((s) => s && /^[A-Z]{2,5}$/.test(s))
      )];
      const catalogMap = new Map();
      if (subjects.length > 0) {
        const settled = await Promise.allSettled(
          subjects.map((s) => getCoursesBySubject({ subject: s }))
        );
        settled.forEach((r) => {
          if (r.status === 'fulfilled') {
            for (const course of r.value?.data?.courses ?? []) {
              // course.code is already "SUBJ NUM" (e.g. "CSCE 331") —
              // the server response has no separate `subject` field.
              catalogMap.set(course.code, {
                title: course.title,
                creditHours: course.creditHours ?? null,
              });
            }
          }
        });
      }
      result.catalogMap = catalogMap;

      setTranscriptParsed(result);
      setShowTranscriptImport(true);
    } catch (err) {
      setTranscriptError(err?.message ?? 'Failed to parse PDF. Make sure it is an official TAMU transcript.');
    } finally {
      setTranscriptLoading(false);
    }
  }

  async function handleTranscriptImportConfirm(importedSemesters) {
    setShowTranscriptImport(false); setTranscriptParsed(null);
    setPlanSaving(true); setPlanSaveError(null);
    try {
      const { data } = await confirmDegreePlanImport(importedSemesters, 'replace');
      const saved = (data.semesters ?? []).map((s) => ({
        ...s,
        _key: s.id,
        courses: (s.courses ?? []).map((c) => ({ ...c, _key: c.id })),
      }));
      setSemesters(saved);
      setExpandedSems(new Set());
      showToast('Plan imported and saved!');
      setIsDirty(false);
    } catch (err) {
      setPlanSaveError(err?.response?.data?.error ?? 'Failed to save imported plan.');
    } finally {
      setPlanSaving(false);
    }
  }

  const graphNodeCount   = graph?.nodes?.filter((n) => n.requirementType === 'required').length ?? 0;
  const hasPlan          = (graph?.nodes?.length ?? 0) > 0;
  const hasDetailedGraph = hasPlan && (graph?.edges?.length ?? 0) > 0;

  // Restrict semester dropdown to catalog year → Spring of (catalogYear + 5).
  // Transcript-imported semesters outside this range still display correctly
  // because SemesterCard always renders the current termCode even when absent from the list.
  const filteredTermOptions = getFilteredTermOptions(termOptions, effectiveCatalogYear);

  return (
    <>
      {toast.msg && (
        <div style={{
          position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9999, borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 500,
          boxShadow: '0 2px 12px rgba(0,0,0,0.15)', pointerEvents: 'none',
          background: toast.type === 'error' ? '#fee2e2' : '#dcfce7',
          color: toast.type === 'error' ? '#991b1b' : '#166534',
          border: `1px solid ${toast.type === 'error' ? '#fca5a5' : '#86efac'}`,
        }}>
          {toast.msg}
        </div>
      )}
      <div className="page-header"><h1>Degree Planner</h1></div>

      {/* Academic Profile */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>Academic Profile</div>
        {profileLoading ? (
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading&hellip;</p>
        ) : (
          <>
            <AcademicProfileEditor
              profile={academicProfile}
              cohortCatalogYear={cohortCatalogYear}
              effectiveCatalogYear={effectiveCatalogYear}
              catalogYearSource={catalogYearSource}
              onSave={handleSaveProfile}
              saving={profileSaving}
              allowMultipleMajors={academicProfile?.secondaryProgramEnabled ?? false}
            />
          </>
        )}
      </div>

      {/* Semester Plan */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>My Semester Plan</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {semesters.length > 0 && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={allExpanded ? collapseAll : expandAll}
                title={allExpanded ? 'Collapse All' : 'Expand All'}
                style={{ padding: '4px 8px', lineHeight: 1, display: 'flex', alignItems: 'center' }}
              >
                <img
                  src={allExpanded ? '/icon-collapse.png' : '/icon-expand.png'}
                  alt={allExpanded ? 'Collapse All' : 'Expand All'}
                  style={{ width: 15, height: 15, objectFit: 'contain' }}
                />
              </button>
            )}
            {semesters.length > 0 && (
              <button type="button" className="btn-danger btn-sm" onClick={handleDeletePlan} disabled={planSaving} style={{ borderRadius: 4 }}>
                Delete Plan
              </button>
            )}
            <label
              className="btn-secondary btn-sm"
              style={{ cursor: transcriptLoading ? 'wait' : 'pointer', opacity: transcriptLoading ? 0.7 : 1 }}
            >
              {transcriptLoading ? 'Parsing PDF…' : 'Import Transcript PDF'}
              <input
                type="file"
                accept=".pdf"
                style={{ display: 'none' }}
                disabled={transcriptLoading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleTranscriptFile(f);
                  e.target.value = '';
                }}
              />
            </label>
            {transcriptError && (
              <div className="alert alert-error" style={{ fontSize: 12, padding: '4px 10px' }}>{transcriptError}</div>
            )}
          </div>
        </div>

        {planLoading ? (
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading plan&hellip;</p>
        ) : (
          <>
            {semesters.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
                No semesters yet. Add one or import your plan.
              </p>
            ) : (
              semesters.map((sem) => (
                <SemesterCard
                  key={sem._key ?? sem.id}
                  semester={sem}
                  termOptions={filteredTermOptions}
                  onChange={(u) => updateSemester(sem._key, u)}
                  onRemove={() => removeSemester(sem._key)}
                  expanded={expandedSems.has(sem._key ?? sem.id)}
                  onToggle={() => toggleExpand(sem._key ?? sem.id)}
                />
              ))
            )}
            {planSaveError && (
              <div className="alert alert-error" style={{ marginTop: 12, marginBottom: 0 }}>{planSaveError}</div>
            )}
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn-secondary" onClick={addSemester} title="Add Semester">Add Semester +</button>
              <button type="button" className="btn-primary" onClick={handleSavePlan} disabled={planSaving}>
                {planSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>

      {showTranscriptImport && transcriptParsed && (
        <TranscriptImportModal
          parsed={transcriptParsed}
          termOptions={termOptions}
          onClose={() => { setShowTranscriptImport(false); setTranscriptParsed(null); }}
          onConfirm={handleTranscriptImportConfirm}
        />
      )}

      {blocker.state === 'blocked' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--color-bg, #fff)', borderRadius: 12, padding: '28px 32px',
            maxWidth: 420, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          }}>
            <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 10 }}>Unsaved changes</div>
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 20 }}>
              You have unsaved changes to your semester plan. If you leave now, your changes will be lost.
            </p>
            {planSaveError && (
              <div style={{ fontSize: 13, color: 'var(--color-danger,#c00)', marginBottom: 12 }}>{planSaveError}</div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-secondary" onClick={() => blocker.reset()}>Stay</button>
              <button type="button" className="btn-danger" onClick={() => blocker.proceed()}>Leave anyway</button>
              <button
                type="button"
                className="btn-primary"
                disabled={planSaving}
                onClick={async () => {
                  await handleSavePlan();
                  blocker.proceed();
                }}
              >
                {planSaving ? 'Saving…' : 'Save & Leave'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
