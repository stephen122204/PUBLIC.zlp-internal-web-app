import { useState, useEffect, useCallback, useRef } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey';

// Catalog year options — last 5 years from current year
const _CY = new Date().getFullYear();
const CATALOG_YEAR_OPTIONS = [];
for (let y = _CY - 4; y <= _CY; y++) {
  CATALOG_YEAR_OPTIONS.push(`Fall ${y}`, `Spring ${y + 1}`, `Summer ${y + 1}`);
}

/** Convert a semester term ("Fall 2023") to an academic year label ("2023-2024"). */
function termToCatalogYear(term) {
  if (!term) return null;
  const m = term.match(/\b(\d{4})\b/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const isFall = /fall/i.test(term);
  const startYear = isFall ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

// Track ids are slugs (e.g. "imaging-sensing-and-digital-health"); render a readable name.
const TRACK_SMALL_WORDS = new Set(['and', 'of', 'the', 'in', 'for', 'to', 'a']);
function humanizeTrackId(id) {
  return String(id ?? '')
    .split('-')
    .map((w, i) => (i > 0 && TRACK_SMALL_WORDS.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
import {
  getCohorts, getCohortMembers, removeMember, getAdminCohortSubmissions, getCyclesForCohort,
  createDummyStudent, removeDummyStudent,
  getAdminStudentSubmission, adminAddStudentCourseRequest, adminDeleteStudentCourseRequest,
  adminSaveStudentSectionPreferences, adminGetCourseSections,
  adminUpdateCourseClassification, adminUpdateStudentSubmissionStatus,
  adminReclassifyStudent,
  getAcademicMajors, saveAdminStudentAcademicProfile,
  getCourseSubjects, getCoursesBySubject,
  getAdminStudentDegreePlan,
  getDegreeGraph,
  getAdminStudentAcademicProfile,
} from '../../api';
import { useAuth } from '../../context/AuthContext';
import AcademicProfileEditor from '../../components/AcademicProfileEditor';
import AcademicProgramPicker from '../../components/AcademicProgramPicker';
import ProfessorGpaPanel from '../../components/ProfessorGpaPanel';
import DegreeFlowchartPanel from '../../components/DegreeFlowchartPanel';

// ---------------------------------------------------------------------------
// CourseAutocompleteForm
// Subject typeahead → course number dropdown → title auto-populated
// ---------------------------------------------------------------------------
function CourseAutocompleteForm({ onAdd, loading }) {
  const [subjects, setSubjects] = useState([]);
  const [subjectQuery, setSubjectQuery] = useState('');
  const [subjectOpen, setSubjectOpen] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState('');
  const [courses, setCourses] = useState([]);
  const [coursesLoading, setCoursesLoading] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState(null); // { courseNumber, title }
  const [courseQuery, setCourseQuery] = useState('');
  const [courseOpen, setCourseOpen] = useState(false);
  const subjectRef = useRef(null);
  const courseRef = useRef(null);

  // Load subjects once
  useEffect(() => {
    getCourseSubjects().then((res) => setSubjects(res.data.subjects ?? [])).catch(() => {});
  }, []);

  // Load courses when subject changes
  useEffect(() => {
    if (!selectedSubject) { setCourses([]); setSelectedCourse(null); setCourseQuery(''); return; }
    setCoursesLoading(true);
    setSelectedCourse(null);
    setCourseQuery('');
    getCoursesBySubject({ subject: selectedSubject })
      .then((res) => setCourses(res.data.courses ?? []))
      .catch(() => setCourses([]))
      .finally(() => setCoursesLoading(false));
  }, [selectedSubject]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e) {
      if (subjectRef.current && !subjectRef.current.contains(e.target)) setSubjectOpen(false);
      if (courseRef.current && !courseRef.current.contains(e.target)) setCourseOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filteredSubjects = subjectQuery
    ? subjects.filter((s) => s.startsWith(subjectQuery.toUpperCase()))
    : subjects;

  const filteredCourses = courseQuery
    ? courses.filter((c) => c.courseNumber.includes(courseQuery) || c.title.toLowerCase().includes(courseQuery.toLowerCase()))
    : courses;

  function pickSubject(subj) {
    setSelectedSubject(subj);
    setSubjectQuery(subj);
    setSubjectOpen(false);
  }

  function pickCourse(course) {
    setSelectedCourse(course);
    setCourseQuery(course.courseNumber);
    setCourseOpen(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!selectedSubject || !selectedCourse) return;
    onAdd({ subject: selectedSubject, number: selectedCourse.courseNumber, title: selectedCourse.title });
  }

  function reset() {
    setSelectedSubject('');
    setSubjectQuery('');
    setSelectedCourse(null);
    setCourseQuery('');
  }

  const canSubmit = selectedSubject && selectedCourse && !loading;

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      {/* Subject */}
      <div ref={subjectRef} style={{ position: 'relative' }}>
        <label style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>Subject *</label>
        <input
          value={subjectQuery}
          onChange={(e) => { setSubjectQuery(e.target.value.toUpperCase()); setSubjectOpen(true); setSelectedSubject(''); setSelectedCourse(null); setCourseQuery(''); }}
          onFocus={() => setSubjectOpen(true)}
          placeholder="MEEN"
          style={{ fontSize: 12, padding: '4px 8px', width: 90 }}
          autoComplete="off"
        />
        {subjectOpen && filteredSubjects.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 200,
            background: 'var(--color-surface, #fff)', border: '1px solid var(--color-border)',
            borderRadius: 4, maxHeight: 200, overflowY: 'auto', minWidth: 90, boxShadow: '0 4px 12px rgba(0,0,0,.12)',
          }}>
            {filteredSubjects.map((s) => (
              <div
                key={s}
                onMouseDown={() => pickSubject(s)}
                style={{
                  padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'monospace',
                  background: s === selectedSubject ? 'var(--color-primary-light, #eef2ff)' : 'transparent',
                }}
              >{s}</div>
            ))}
          </div>
        )}
      </div>

      {/* Course number */}
      <div ref={courseRef} style={{ position: 'relative' }}>
        <label style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>Number *</label>
        <input
          value={courseQuery}
          onChange={(e) => { setCourseQuery(e.target.value); setCourseOpen(true); setSelectedCourse(null); }}
          onFocus={() => { if (selectedSubject) setCourseOpen(true); }}
          placeholder={selectedSubject ? (coursesLoading ? 'Loading…' : '121') : '—'}
          disabled={!selectedSubject}
          style={{ fontSize: 12, padding: '4px 8px', width: 80 }}
          autoComplete="off"
        />
        {courseOpen && filteredCourses.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 200,
            background: 'var(--color-surface, #fff)', border: '1px solid var(--color-border)',
            borderRadius: 4, maxHeight: 220, overflowY: 'auto', minWidth: 280, boxShadow: '0 4px 12px rgba(0,0,0,.12)',
          }}>
            {filteredCourses.map((c) => (
              <div
                key={c.courseNumber}
                onMouseDown={() => pickCourse(c)}
                style={{
                  padding: '5px 10px', fontSize: 12, cursor: 'pointer',
                  background: selectedCourse?.courseNumber === c.courseNumber ? 'var(--color-primary-light, #eef2ff)' : 'transparent',
                  display: 'flex', gap: 8,
                }}
              >
                <span style={{ fontFamily: 'monospace', fontWeight: 600, minWidth: 40 }}>{c.courseNumber}</span>
                <span style={{ color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Title — read-only, auto-populated */}
      <div style={{ flex: 1, minWidth: 160 }}>
        <label style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>Title</label>
        <input
          value={selectedCourse?.title ?? ''}
          readOnly
          placeholder="Auto-populated"
          style={{ fontSize: 12, padding: '4px 8px', width: '100%', background: 'var(--color-bg-muted, #f9f9f9)', color: 'var(--color-text-muted)' }}
        />
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="btn-primary btn-sm" disabled={!canSubmit} style={{ fontSize: 12 }} title="Add">
          {loading ? 'Adding…' : <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1 }}>+</span>}
        </button>
        {(selectedSubject || selectedCourse) && (
          <button type="button" className="btn-secondary btn-sm" style={{ fontSize: 12 }} onClick={reset}>Clear</button>
        )}
      </div>
    </form>
  );
}

export default function AdminStudents() {
  const { user } = useAuth();
  const isDeveloper = user?.role === 'developer';

  const [cohorts, setCohorts] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [cycles, setCycles] = useState([]);
  const [selectedCycleId, setSelectedCycleId] = useState('');
  const [members, setMembers] = useState([]);
  const [submissions, setSubmissions] = useState([]); // from /submissions endpoint
  const [cohortsLoading, setCohortsLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [expandedRows, setExpandedRows] = useState(new Set()); // userIds of expanded rows
  // Review modal
  const [reviewStudentId, setReviewStudentId] = useState(null);
  // Add Dummy Student modal (developer-only)
  const [showAddDummy, setShowAddDummy] = useState(false);

  useEffect(() => {
    getCohorts().then((res) => {
      setCohorts(res.data);
      if (res.data.length > 0) setSelectedId(res.data[0]._id);
    }).finally(() => setCohortsLoading(false));
  }, []);

  // Load cycles when cohort changes
  useEffect(() => {
    if (!selectedId) return;
    setCycles([]);
    setSelectedCycleId('');
    getCyclesForCohort(selectedId).then((res) => {
      const list = res.data.cycles ?? [];
      setCycles(list);
      // Default to active cycle
      const active = list.find((c) => c.activeForStudents);
      setSelectedCycleId(active?._id ?? (list[0]?._id ?? ''));
    }).catch(() => {});
  }, [selectedId]);

  const loadMembers = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    setError('');
    setExpandedRows(new Set());
    try {
      const [membersRes, subsRes] = await Promise.all([
        getCohortMembers(selectedId),
        getAdminCohortSubmissions(selectedId, selectedCycleId || undefined),
      ]);
      setMembers(membersRes.data);
      setSubmissions(subsRes.data.submissions ?? []);
    } catch {
      setError('Failed to load members.');
    } finally {
      setLoading(false);
    }
  }, [selectedId, selectedCycleId]);

  useEffect(() => { loadMembers(); }, [loadMembers]);

  const handleRemove = async (member) => {
    const userId = member.userId?._id;
    const userName = member.userId?.name;
    const isDummy = member.userId?.isDummy;
    if (!window.confirm(`Remove ${userName} from this cohort?`)) return;
    setRemoving(userId);
    try {
      if (isDummy) {
        await removeDummyStudent(userId);
      } else {
        await removeMember(selectedId, userId);
      }
      setMembers((prev) => prev.filter((m) => m.userId?._id !== userId));
      setSubmissions((prev) => prev.filter((s) => s.student?.id !== userId));
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to remove student.');
    } finally {
      setRemoving(null);
    }
  };

  const handleDummyCreated = () => {
    setShowAddDummy(false);
    loadMembers();
  };

  const selectedCohort = cohorts.find((c) => c._id === selectedId);

  // Build a lookup map: userId → submission entry
  const subMap = {};
  for (const s of submissions) {
    if (s.student?.id) subMap[s.student.id] = s;
  }

  function submissionBadge(subEntry) {
    if (!subEntry || !subEntry.submission) return <span className="badge badge-none">Not Started</span>;
    const { status } = subEntry.submission;
    if (status === 'submitted') return <span className="badge badge-active">Submitted</span>;
    if (status === 'draft') return <span className="badge badge-expired">Draft</span>;
    if (status === 'locked') return <span className="badge badge-removed">Locked</span>;
    return <span className="badge badge-none">{status}</span>;
  }

  return (
    <>
      <div className="page-header">
        <h1>Cohort Members / Students</h1>
        {isDeveloper && selectedId && (
          <button className="btn-primary" style={{ fontSize: 18, fontWeight: 700, lineHeight: 1 }} onClick={() => setShowAddDummy(true)} title="Add Dummy Student">
            +
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="cohort-select-row">
        <label>Cohort:</label>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          {cohorts.map((c) => (
            <option key={c._id} value={c._id}>
              {c.name}
            </option>
          ))}
        </select>
        {cycles.length > 0 && (
          <>
            <label style={{ marginLeft: 16 }}>Cycle:</label>
            <select value={selectedCycleId} onChange={(e) => setSelectedCycleId(e.target.value)}>
              {cycles.map((cy) => (
                <option key={cy._id} value={cy._id}>
                  {cy.name || cy.term} ({cy.termCode}) — {cy.status}{cy.activeForStudents ? ' ★' : ''}
                </option>
              ))}
            </select>
          </>
        )}
        {cycles.length === 0 && selectedId && (
          <span style={{ marginLeft: 16, fontSize: 13, color: 'var(--color-text-muted)' }}>
            No scheduling cycles
          </span>
        )}
      </div>

      {(cohortsLoading || loading) ? (
        <div className="empty-state"><p>Loading members…</p></div>
      ) : members.length === 0 ? (
        <div className="empty-state">
          <h3>No students yet</h3>
          <p>
            {selectedCohort
              ? `No active members in ${selectedCohort.name}. Share the invite link to add students.`
              : 'Select a cohort to view members.'}
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Joined</th>
                  <th>Last Login</th>
                  <th>Submission</th>
                  <th>Courses</th>
                  <th>Sections</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const uid = m.userId?._id;
                  const subEntry = uid ? subMap[uid] : null;
                  const isExpanded = expandedRows.has(uid);
                  const isDummyMember = m.userId?.isDummy;
                  return [
                    <tr key={m._id} style={{ cursor: 'pointer' }} onClick={() => setExpandedRows((prev) => { const next = new Set(prev); isExpanded ? next.delete(uid) : next.add(uid); return next; })}>
                      <td>
                        <strong>{m.userId?.name || '—'}</strong>
                        {isDummyMember && (
                          <span className="badge badge-removed" style={{ marginLeft: 6, fontSize: 10, verticalAlign: 'middle' }}>Dummy</span>
                        )}
                      </td>
                      <td className="text-sm">{m.userId?.email || '—'}</td>
                      <td className="text-sm">
                        {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '—'}
                      </td>
                      <td className="text-sm">
                        {m.userId?.lastLoginAt
                          ? new Date(m.userId.lastLoginAt).toLocaleDateString()
                          : '—'}
                      </td>
                      <td>{submissionBadge(subEntry)}</td>
                      <td className="text-sm">{subEntry?.courseCount ?? '—'}</td>
                      <td className="text-sm">{subEntry?.preferredSectionCount ?? '—'}</td>
                      <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn-primary btn-sm"
                          style={{ fontSize: 11, padding: '3px 6px', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                          onClick={() => setReviewStudentId(uid)}
                          title="Review"
                        >
                          <img src="/icon-review.png" alt="Review" style={{ width: 13, height: 13, objectFit: 'contain', filter: 'brightness(0) invert(1)' }} />
                        </button>
                        <button
                          className="btn-danger btn-sm"
                          disabled={removing === uid}
                          onClick={() => handleRemove(m)}
                          title="Remove student"
                          style={{ padding: '3px 6px', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          {removing === uid
                            ? '…'
                            : <img src="/icon-remove.png" alt="Remove" style={{ width: 13, height: 13, objectFit: 'contain', filter: 'brightness(0) invert(1)' }} />
                          }
                        </button>
                      </td>
                    </tr>,
                    isExpanded && subEntry && (
                      <tr key={`${m._id}-detail`} style={{ background: 'var(--color-surface)' }}>
                        <td colSpan={8} style={{ padding: '16px 20px' }}>
                          <SubmissionDetail entry={subEntry} />
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Review modal */}
      {reviewStudentId && (
        <StudentReviewModal
          studentId={reviewStudentId}
          cohortId={selectedId}
          cycleId={selectedCycleId}
          cohortCatalogYear={selectedCohort?.catalogYear ?? null}
          onClose={() => { setReviewStudentId(null); loadMembers(); }}
          onDataLoaded={(sid, majorTitle) => {
            setSubmissions((prev) =>
              prev.map((s) => s.student?.id === sid ? { ...s, primaryMajor: majorTitle } : s)
            );
          }}
        />
      )}

      {/* Add Dummy Student modal (developer only) */}
      {showAddDummy && isDeveloper && (
        <AddDummyStudentModal
          cohortId={selectedId}
          cohortName={selectedCohort?.name}
          onClose={() => setShowAddDummy(false)}
          onCreated={handleDummyCreated}
        />
      )}
    </>
  );
}

function SubmissionDetail({ entry }) {
  const { submission, degreePlanSelection, primaryMajor, courses } = entry;
  const degreeLabel = primaryMajor || degreePlanSelection?.planTitle || null;
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <strong>Degree:</strong>{' '}
          {degreeLabel
            ? degreeLabel
            : <em style={{ color: 'var(--color-text-muted)' }}>Not selected</em>}
        </div>
        {submission?.submittedAt && (
          <div>
            <strong>Submitted:</strong>{' '}
            {new Date(submission.submittedAt).toLocaleString()}
          </div>
        )}
        {submission?.lastEditedAt && (
          <div>
            <strong>Last Edited:</strong>{' '}
            {new Date(submission.lastEditedAt).toLocaleString()}
          </div>
        )}
      </div>
      {courses.length === 0 ? (
        <em style={{ color: 'var(--color-text-muted)' }}>No courses added.</em>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>Code</th>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>Title</th>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>System Classification</th>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>Final Classification</th>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>Preferred Sections</th>
            </tr>
          </thead>
          <tbody>
            {courses.map((c) => (
              <tr key={c.code} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '4px 8px', fontWeight: 600 }}>{c.code}</td>
                <td style={{ padding: '4px 8px' }}>{c.title || '—'}</td>
                <td style={{ padding: '4px 8px' }}>
                  <span className={`badge ${
                    c.systemClassification === 'required'   ? 'badge-active'
                    : c.systemClassification === 'preferred'  ? 'badge-pending'
                    : c.systemClassification === 'not_applied' ? 'badge-removed'
                    : 'badge-default'
                  }`} style={{ fontSize: 11, color: (c.systemClassification === 'not_applied' || !c.systemClassification) ? '#1a1a1a' : undefined }}>{c.systemClassification}</span>
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <span className={`badge ${
                    c.finalClassification === 'required'   ? 'badge-active'
                    : c.finalClassification === 'preferred'  ? 'badge-pending'
                    : c.finalClassification === 'not_applied' ? 'badge-removed'
                    : 'badge-default'
                  }`} style={{ fontSize: 11, color: (c.finalClassification === 'not_applied' || !c.finalClassification) ? '#1a1a1a' : undefined }}>{c.finalClassification}</span>
                </td>
                <td style={{ padding: '4px 8px' }}>
                  {c.preferredSections.length === 0
                    ? <span style={{ color: 'var(--color-text-muted)' }}>None</span>
                    : c.preferredSections.map((s) => (
                        <div key={s.crn}>
                          CRN {s.crn} §{s.section}
                          {s.instructorLabel ? ` — ${s.instructorLabel}` : ''}
                        </div>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddDummyStudentModal — developer-only
// ---------------------------------------------------------------------------
function AddDummyStudentModal({ cohortId, cohortName, onClose, onCreated }) {
  useEscapeKey(onClose);
  const [names, setNames] = useState(['']);
  const [primaryMajorId, setPrimaryMajorId] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState(null); // { succeeded, failed }

  const setName = (i, val) => setNames((prev) => prev.map((n, idx) => idx === i ? val : n));
  const addRow = () => setNames((prev) => [...prev, '']);
  const removeRow = (i) => setNames((prev) => prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i));

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = names.map((n) => n.trim()).filter(Boolean);
    if (trimmed.length === 0) { setError('At least one name is required.'); return; }
    setLoading(true);
    setError('');
    const succeeded = [];
    const failed = [];
    for (const name of trimmed) {
      try {
        await createDummyStudent(cohortId, { name, primaryMajorId: primaryMajorId || undefined });
        succeeded.push(name);
      } catch (err) {
        failed.push({ name, reason: err?.response?.data?.error || 'Unknown error' });
      }
    }
    setLoading(false);
    if (succeeded.length > 0) {
      setResults({ succeeded, failed });
    } else {
      setError(failed.map((f) => `${f.name}: ${f.reason}`).join('; '));
    }
  };

  if (results) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>Dummy Students Created</h2>
          {results.succeeded.length > 0 && (
            <div className="alert alert-success" style={{ marginBottom: 8 }}>
              Created: {results.succeeded.join(', ')}
            </div>
          )}
          {results.failed.length > 0 && (
            <div className="alert alert-error">
              Failed: {results.failed.map((f) => `${f.name} (${f.reason})`).join('; ')}
            </div>
          )}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => { onCreated(); onClose(); }}>Close</button>
            <button className="btn-primary" onClick={() => { onCreated(); setNames(['']); setResults(null); }}>Add More</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380, display: 'flex', flexDirection: 'column', maxHeight: '70vh' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Add Dummy Students</h3>
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '0 0 10px', flexShrink: 0 }}>
          Test students in <strong>{cohortName}</strong> (no Google account).
        </p>
        {error && <div className="alert alert-error" style={{ flexShrink: 0, fontSize: 12, padding: '6px 10px', marginBottom: 8 }}>{error}</div>}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, flex: 1 }}>
          <div className="form-group" style={{ flexShrink: 0, marginBottom: 2 }}>
            <label style={{ fontSize: 12 }}>Primary Major (optional)</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
              <span style={{ fontSize: 12, color: primaryMajorId ? 'inherit' : 'var(--color-text-muted)' }}>
                {primaryMajorId ?? '— None —'}
              </span>
              <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => setShowPicker(true)}>
                {primaryMajorId ? 'Change' : 'Select'}
              </button>
              {primaryMajorId && (
                <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => setPrimaryMajorId(null)}>Clear</button>
              )}
            </div>
          </div>
          <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 2 }}>
            {names.map((n, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  style={{ flex: 1, fontSize: 13, padding: '4px 8px' }}
                  value={n}
                  onChange={(e) => setName(i, e.target.value)}
                  placeholder={`Student name ${i + 1}`}
                  autoFocus={i === 0}
                />
                {names.length > 1 && (
                  <button type="button" className="btn-secondary" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => removeRow(i)}>✕</button>
                )}
              </div>
            ))}
          </div>
          <button type="button" className="btn-secondary" style={{ alignSelf: 'flex-start', marginTop: 2, flexShrink: 0, fontSize: 16, fontWeight: 700, lineHeight: 1, padding: '3px 10px' }} onClick={addRow} title="Add Another">
            +
          </button>
          <div className="modal-actions" style={{ marginTop: 6, flexShrink: 0 }}>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Creating…' : `Create ${names.filter(n => n.trim()).length || ''} Dummy Student${names.filter(n => n.trim()).length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
      </div>
      {showPicker && (
        <AcademicProgramPicker
          type="major"
          value={primaryMajorId}
          multiple={false}
          onChange={(id) => { setPrimaryMajorId(id); setShowPicker(false); }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DegreePlanTab — read-only view of a student's semester plan (admin)
// ---------------------------------------------------------------------------
function DegreePlanTab({ studentId, cohortId, academicProfile: profileFromParent, onProfileChanged }) {
  const [semesters, setSemesters]         = useState(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [secondaryEnabled, setSecondaryEnabled] = useState(profileFromParent?.secondaryProgramEnabled ?? false);
  const [toggling, setToggling]           = useState(false);
  const [toggleMsg, setToggleMsg]         = useState('');
  // Live profile — used only for the secondaryProgramEnabled toggle (admin override flag).
  // The major/catalog display uses profileFromParent, which is already snapshot-resolved
  // by the server (snapshot when submitted, live when draft).
  const [liveProfile, setLiveProfile] = useState(profileFromParent ?? null);

  // Fetch fresh live profile on mount so the secondary-program checkbox always reflects DB state.
  // This intentionally uses the live endpoint (not the snapshot) because secondaryProgramEnabled
  // is an admin override flag that the server explicitly keeps outside the snapshot.
  useEffect(() => {
    let mounted = true;
    getAdminStudentAcademicProfile(studentId, cohortId)
      .then((res) => {
        if (!mounted) return;
        const p = res.data.profile ?? res.data;
        setLiveProfile(p);
        setSecondaryEnabled(p?.secondaryProgramEnabled ?? false);
      })
      .catch(() => {
        // Fall back to parent-provided value if fetch fails
        setSecondaryEnabled(profileFromParent?.secondaryProgramEnabled ?? false);
      });
    return () => { mounted = false; };
  }, [studentId, cohortId]);

  useEffect(() => {
    let mounted = true;
    setLoading(true); setError('');
    getAdminStudentDegreePlan(studentId, cohortId)
      .then((res) => { if (mounted) setSemesters(res.data.semesters ?? []); })
      .catch((err) => { if (mounted) setError(err?.response?.data?.error ?? 'Failed to load degree plan.'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [studentId, cohortId]);

  async function handleSecondaryToggle(e) {
    const next = e.target.checked;
    setSecondaryEnabled(next);
    setToggling(true); setToggleMsg('');
    try {
      const res = await saveAdminStudentAcademicProfile(studentId, {
        cohortId,
        secondaryProgramEnabled: next,
        primaryMajorId:     liveProfile?.primaryMajor?.programId ?? null,
        additionalMajorIds: (liveProfile?.additionalMajors ?? []).map((p) => p.programId),
        minorIds:           (liveProfile?.minors ?? []).map((p) => p.programId),
        catalogYear:        liveProfile?.catalogYear ?? null,
      });
      const saved = res.data.profile ?? res.data;
      setLiveProfile(saved);
      onProfileChanged?.(saved);
      setToggleMsg(next ? 'Secondary program enabled.' : 'Secondary program disabled.');
    } catch {
      setSecondaryEnabled(!next);
      setToggleMsg('Failed to save — please try again.');
    } finally {
      setToggling(false);
    }
  }

  if (loading) return <p style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: 8 }}>Loading degree plan&hellip;</p>;
  if (error)   return <div className="alert alert-error" style={{ marginTop: 8 }}>{error}</div>;

  // Use the snapshot-resolved profile passed from the parent for major/catalog display.
  // profileFromParent is already resolved by the server: snapshot if submitted, live if draft.
  // Fall back to liveProfile only when no parent profile is available (e.g. no submission yet).
  const displayProfile = profileFromParent ?? liveProfile;
  const primary    = displayProfile?.primaryMajor;
  const additional = displayProfile?.additionalMajors ?? [];
  const minors     = displayProfile?.minors ?? [];

  function statusBadge(s) {
    if (s === 'completed')  return { background: 'transparent', color: '#065f46' };
    if (s === 'in_progress') return { background: 'transparent', color: '#1e40af' };
    return { background: 'transparent', color: '#374151' };
  }
  function statusLabel(s) {
    if (s === 'completed')  return 'Completed';
    if (s === 'in_progress') return 'In Progress';
    return 'Planned';
  }

  const totalHrs = semesters.reduce((sum, sem) =>
    sum + (sem.courses ?? []).reduce((s2, c) => s2 + (Number(c.creditHours) || 0), 0), 0);

  return (
    <div style={{ marginTop: 8 }}>
      {/* Enrolled programs summary */}
      {(primary || additional.length > 0 || minors.length > 0) && (
        <div style={{ fontSize: 13, marginBottom: 4, lineHeight: 1.8 }}>
          {primary && (
            <div><strong>Major:</strong> {primary.title}{primary.catalog ? ` (${primary.catalog})` : ''}</div>
          )}
          {additional.map((p) => (
            <div key={p.programId}><strong>+ Major:</strong> {p.title}{p.catalog ? ` (${p.catalog})` : ''}</div>
          ))}
          {minors.map((p) => (
            <div key={p.programId}><strong>Minor:</strong> {p.title}</div>
          ))}
        </div>
      )}
      {/* Secondary program toggle */}
      <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--color-border)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: toggling ? 'wait' : 'pointer', width: 'fit-content' }}>
          <input type="checkbox" checked={secondaryEnabled} onChange={handleSecondaryToggle} disabled={toggling} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Secondary Program Enabled</span>
        </label>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 3, marginLeft: 24 }}>
          Allows this student to add additional majors or dual-degree programs.
        </div>
        {toggleMsg && (
          <div style={{ fontSize: 12, marginTop: 4, marginLeft: 24, color: toggleMsg.startsWith('Failed') ? '#b91c1c' : '#166534' }}>
            {toggleMsg}
          </div>
        )}
      </div>
      {!semesters?.length ? (
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>No semester plan found for this student.</p>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            {semesters.length} semester{semesters.length !== 1 ? 's' : ''} &middot; {totalHrs} total credit hrs (planned)
          </div>
          {semesters.map((sem, si) => {
            const semHrs = (sem.courses ?? []).reduce((s, c) => s + (Number(c.creditHours) || 0), 0);
            return (
              <div key={sem.id ?? si} style={{ marginBottom: 14, border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--color-surface,#fff)', borderBottom: '1px solid var(--color-border)' }}>
                  <span style={{ ...statusBadge(sem.status), borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: sem.status === 'completed' ? 700 : 400, fontStyle: 'italic' }}>
                    {statusLabel(sem.status)}
                  </span>
                  <strong style={{ fontSize: 14 }}>{sem.label || `Semester ${si + 1}`}</strong>
                  {sem.term && sem.year && (
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{sem.term} {sem.year}</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {semHrs > 0 ? `${semHrs} hrs \u00b7 ` : ''}{(sem.courses ?? []).length} course{(sem.courses ?? []).length !== 1 ? 's' : ''}
                  </span>
                </div>
                {(sem.courses ?? []).length > 0 ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <tbody>
                      {(sem.courses ?? []).map((c, ci) => (
                        <tr key={c.id ?? ci} style={{ borderBottom: ci < sem.courses.length - 1 ? '1px solid var(--color-border)' : undefined }}>
                          <td style={{ padding: '5px 12px', fontWeight: 700, fontFamily: 'monospace', width: 90 }}>{c.code}</td>
                          <td style={{ padding: '5px 8px', color: '#374151' }}>{c.title || <em style={{ color: 'var(--color-text-muted)' }}>Untitled</em>}</td>
                          <td style={{ padding: '5px 8px', color: 'var(--color-text-muted)', width: 40, textAlign: 'right' }}>{c.creditHours != null ? `${c.creditHours}h` : ''}</td>
                          <td style={{ padding: '5px 8px', width: 60 }}>
                            {c.transfer && <span style={{ fontSize: 10, background: '#eff6ff', color: '#1d4ed8', borderRadius: 3, padding: '1px 5px', marginRight: 3 }}>Transfer</span>}
                            {c.honors   && <span style={{ fontSize: 10, background: '#faf5ff', color: '#6b21a8', borderRadius: 3, padding: '1px 5px' }}>Honors</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-text-muted)' }}>No courses in this semester.</div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// DegreeFlowchartTab — ReactFlow flowchart for the student's primary major
// ---------------------------------------------------------------------------
function DegreeFlowchartTab({ studentId, cohortId, academicProfile }) {
  const [graph, setGraph]       = useState(null);
  const [semesters, setSemesters] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  useEffect(() => {
    const programId = academicProfile?.primaryMajor?.programId;
    if (!programId) {
      setLoading(false);
      setError('No primary major set for this student.');
      return;
    }
    let mounted = true;
    setLoading(true); setError('');
    Promise.all([
      getDegreeGraph(programId),
      getAdminStudentDegreePlan(studentId, cohortId),
    ])
      .then(([graphRes, planRes]) => {
        if (!mounted) return;
        setGraph(graphRes.data.graph ?? null);
        setSemesters(planRes.data.semesters ?? []);
      })
      .catch((err) => {
        if (mounted) setError(err?.response?.data?.error ?? 'Failed to load degree flowchart.');
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [studentId, cohortId, academicProfile]);

  if (loading) return <p style={{ fontSize: 13, color: 'var(--color-text-muted)', padding: 8 }}>Loading flowchart&hellip;</p>;
  if (error)   return <div className="alert alert-error" style={{ marginTop: 8 }}>{error}</div>;

  return <DegreeFlowchartPanel graph={graph} semesters={semesters} height={560} selectedTrackId={academicProfile?.primaryMajor?.selectedTrackId ?? null} />;
}

// ---------------------------------------------------------------------------
// SectionPrefsEditorModal
// Admin editor for selecting preferred sections on a per-student course request.
// ---------------------------------------------------------------------------
function SectionPrefsEditorModal({ studentId, courseRequest, termCode, onClose, onSaved }) {
  useEscapeKey(onClose);
  const [available, setAvailable]   = useState([]);
  const [gradeStats, setGradeStats] = useState(null);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [sectionsError, setSectionsError]     = useState('');
  // Set of selected CRNs (string)
  const [selected, setSelected]     = useState(() => new Set((courseRequest.preferredSections ?? []).map((p) => String(p.crn))));
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Build a lookup from CRN → full section object so we can send full data on save
  const availableMap = useRef({});

  useEffect(() => {
    if (!termCode) { setSectionsLoading(false); setSectionsError('No term code for this cycle.'); return; }
    const [subj, num] = courseRequest.code.split(' ');
    setSectionsLoading(true);
    setSectionsError('');
    adminGetCourseSections(subj, num, termCode)
      .then((res) => {
        const secs = res.data.sections ?? [];
        setAvailable(secs);
        setGradeStats(res.data.gradeStats ?? null);
        const map = {};
        for (const s of secs) map[String(s.crn)] = s;
        availableMap.current = map;
        // Pre-select from current preferredSections — keep selections even if not yet in available list
        setSelected(new Set((courseRequest.preferredSections ?? []).map((p) => String(p.crn))));
      })
      .catch((err) => setSectionsError(err?.response?.data?.error ?? 'Failed to load sections.'))
      .finally(() => setSectionsLoading(false));
  }, [courseRequest.code, termCode]);

  const toggle = (crn) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(crn)) next.delete(crn); else next.add(crn);
      return next;
    });
    setSaveSuccess(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    const sections = [...selected].map((crn) => {
      const sec = availableMap.current[crn];
      if (sec) {
        const instructorLabel = (sec.instructors ?? []).map((i) => i.name ?? i).filter(Boolean).join(', ');
        const meetings = (sec.meetings ?? []).map((m) => ({
          days: m.days ?? '',
          startTime: m.startTime ?? null,
          endTime: m.endTime ?? null,
          location: m.location ?? null,
        }));
        return { crn, section: sec.section ?? '', instructorLabel, meetings, termCode };
      }
      // Fall back to existing snapshot data if section no longer in available list
      const existing = (courseRequest.preferredSections ?? []).find((p) => String(p.crn) === crn);
      return existing
        ? { crn, section: existing.section ?? '', instructorLabel: existing.instructorLabel ?? '', meetings: existing.meetings ?? [], termCode }
        : { crn, section: '', instructorLabel: '', meetings: [], termCode };
    });
    try {
      const res = await adminSaveStudentSectionPreferences(studentId, courseRequest.id, { sections });
      setSaveSuccess(true);
      onSaved(courseRequest.id, res.data.preferredSections ?? []);
    } catch (err) {
      setSaveError(err?.response?.data?.error ?? 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  function formatMeetings(meetings) {
    if (!meetings?.length) return null;
    return meetings.map((m) => {
      const time = m.startTime && m.endTime ? ` ${m.startTime}–${m.endTime}` : '';
      const loc  = m.location ? ` · ${m.location}` : '';
      return `${m.days ?? '?'}${time}${loc}`;
    }).join(' | ');
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 680, width: '96vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Preferred Sections — <span style={{ fontFamily: 'monospace' }}>{courseRequest.code}</span></h3>
            {courseRequest.title && <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 2 }}>{courseRequest.title}</div>}
          </div>
          <button className="btn-secondary" style={{ fontSize: 12 }} onClick={onClose}>✕</button>
        </div>

        <div style={{ fontSize: 12, color: '#1e40af', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '8px 12px', marginBottom: 12 }}>
          <strong>Note:</strong> Preferred sections affect the <em>Sections-Preferred</em> algorithm run for this student course request only.
          The <em>Required</em> and <em>Preferred</em> tiers use all available sections regardless of this setting.
          Any Changes sync to the submitted snapshot immediately. No re‑submit is necessary.
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {sectionsLoading && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading sections…</p>}
          {sectionsError  && <div className="alert alert-error">{sectionsError}</div>}
          {!sectionsLoading && !sectionsError && available.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              No section data found for <strong>{courseRequest.code}</strong> in term <strong>{termCode}</strong>.
            </p>
          )}
          {!sectionsLoading && available.length > 0 && (
            <ProfessorGpaPanel gradeStats={gradeStats} compact />
          )}
          {!sectionsLoading && available.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--color-surface)', borderBottom: '2px solid var(--color-border)' }}>
                  <th style={{ padding: '5px 8px', width: 28 }}></th>
                  <th style={{ padding: '5px 8px', textAlign: 'left' }}>CRN</th>
                  <th style={{ padding: '5px 8px', textAlign: 'left' }}>Section</th>
                  <th style={{ padding: '5px 8px', textAlign: 'left' }}>Instructor</th>
                  <th style={{ padding: '5px 8px', textAlign: 'left' }}>Schedule</th>
                </tr>
              </thead>
              <tbody>
                {available.map((sec) => {
                  const crn = String(sec.crn);
                  const checked = selected.has(crn);
                  const instructorLabel = (sec.instructors ?? []).map((i) => i.name ?? i).filter(Boolean).join(', ') || '—';
                  const schedule = formatMeetings(sec.meetings) ?? '—';
                  return (
                    <tr
                      key={crn}
                      onClick={() => toggle(crn)}
                      style={{
                        borderBottom: '1px solid var(--color-border)',
                        background: checked ? '#f0fdf4' : undefined,
                        cursor: 'pointer',
                      }}
                    >
                      <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                        <input type="checkbox" checked={checked} onChange={() => toggle(crn)} onClick={(e) => e.stopPropagation()} />
                      </td>
                      <td style={{ padding: '5px 8px', fontFamily: 'monospace' }}>{crn}</td>
                      <td style={{ padding: '5px 8px', fontFamily: 'monospace' }}>{sec.section}</td>
                      <td style={{ padding: '5px 8px' }}>{instructorLabel}</td>
                      <td style={{ padding: '5px 8px', color: 'var(--color-text-muted)' }}>{schedule}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)', flex: 1 }}>
            {selected.size === 0 ? 'None selected implies algorithm utilizes all sections.' : `${selected.size} section${selected.size !== 1 ? 's' : ''} selected`}
          </span>
          {saveError   && <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{saveError}</span>}
          {saveSuccess && <span style={{ fontSize: 12, color: '#16a34a' }}>&#10003; Saved</span>}
          <button className="btn-secondary" style={{ fontSize: 12 }} onClick={onClose}>Cancel</button>
          <button className="btn-primary" style={{ fontSize: 12 }} disabled={saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// StudentReviewModal — admin/developer
// ---------------------------------------------------------------------------
const CLASSIFICATION_OPTIONS = ['required', 'preferred', 'not_applied'];

function StudentReviewModal({ studentId, cohortId, cycleId, onClose, cohortCatalogYear, onDataLoaded }) {
  useEscapeKey(onClose);
  const { user: authUser } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Per-course override state: { [courseId]: { finalClassification, finalClassificationReason, saving, error } }
  const [overrides, setOverrides] = useState({});
  // Academic profile edit modal
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  // Section preferences editor — holds the courseRequest to edit, or null
  const [sectionPrefsTarget, setSectionPrefsTarget] = useState(null);
  // Degree plan tab
  const [activeTab, setActiveTab] = useState('courses');
  // Add course error
  const [addError, setAddError] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  // Submission status toggle
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');
  // Reclassify
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyError, setReclassifyError] = useState('');
  const [reclassifySuccess, setReclassifySuccess] = useState('');
  // Credit hour override (inline above Course Requests)
  const [creditOverrideSaving, setCreditOverrideSaving] = useState(false);
  const [creditOverrideError, setCreditOverrideError] = useState('');
  const [creditOverrideSaved, setCreditOverrideSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getAdminStudentSubmission(studentId, {
        cohortId,
        ...(cycleId ? { cycleId } : {}),
      });
      setData(res.data);
      // Propagate the resolved major back to the list so the expanded row stays in sync
      onDataLoaded?.(studentId, res.data.academicProfile?.primaryMajor?.title ?? null);
      // Init override state from loaded data
      const init = {};
      for (const cr of res.data.courseRequests ?? []) {
        init[cr.id] = {
          finalClassification: cr.finalClassification,
          finalClassificationReason: cr.finalClassificationReason ?? '',
          saving: false,
          error: '',
        };
      }
      setOverrides(init);
      overridesRef.current = init;
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load student data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [studentId, cohortId, cycleId]);

  // Mirror ref so debounced callbacks always read the latest values without stale closures
  const overridesRef = useRef({});
  const saveTimers = useRef({});

  const handleOverrideChange = (courseId, field, value) => {
    const updated = { ...overridesRef.current[courseId], [field]: value, saved: false };
    overridesRef.current = { ...overridesRef.current, [courseId]: updated };
    setOverrides((prev) => ({ ...prev, [courseId]: updated }));
    clearTimeout(saveTimers.current[courseId]);
    saveTimers.current[courseId] = setTimeout(() => doSaveOverride(courseId), 600);
  };

  const doSaveOverride = async (courseId) => {
    const ov = overridesRef.current[courseId];
    if (!ov) return;
    setOverrides((prev) => ({ ...prev, [courseId]: { ...prev[courseId], saving: true, error: '', saved: false } }));
    try {
      const res = await adminUpdateCourseClassification(studentId, courseId, {
        finalClassification: ov.finalClassification,
        finalClassificationReason: ov.finalClassificationReason || null,
      });
      setData((prev) => ({
        ...prev,
        courseRequests: prev.courseRequests.map((cr) => cr.id === courseId ? { ...cr, ...res.data } : cr),
      }));
      setOverrides((prev) => ({ ...prev, [courseId]: { ...prev[courseId], saving: false, saved: true, error: '' } }));
    } catch (err) {
      setOverrides((prev) => ({
        ...prev,
        [courseId]: { ...prev[courseId], saving: false, saved: false, error: err?.response?.data?.error || 'Save failed.' },
      }));
    }
  };

  const handleDeleteCourse = async (courseId) => {
    if (!window.confirm('Remove this course from the student\'s plan?')) return;
    try {
      await adminDeleteStudentCourseRequest(studentId, courseId, {
        cohortId,
        cycleId: data?.cycle?.id,
      });
      setData((prev) => ({ ...prev, courseRequests: prev.courseRequests.filter((cr) => cr.id !== courseId) }));
      setOverrides((prev) => { const next = { ...prev }; delete next[courseId]; return next; });
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to remove course.');
    }
  };

  const handleSetSubmissionStatus = async (status) => {
    if (!data?.cycle?.id) return;
    setStatusLoading(true);
    setStatusError('');
    try {
      await adminUpdateStudentSubmissionStatus(studentId, {
        cohortId,
        cycleId: data.cycle.id,
        status,
      });
      // Reload full modal data so dataSource and course snapshot are refreshed
      const fullRes = await getAdminStudentSubmission(studentId, { cohortId, cycleId: data.cycle.id });
      setData((prev) => ({
        ...fullRes.data,
        academicProfile: {
          ...fullRes.data.academicProfile,
          // Keep the live override flags; the full reload may use a snapshot that predates the override
          allowOverCreditSubmission:   fullRes.data.academicProfile?.allowOverCreditSubmission   ?? prev?.academicProfile?.allowOverCreditSubmission   ?? false,
          allowOverCreditSubmissionBy: fullRes.data.academicProfile?.allowOverCreditSubmissionBy ?? prev?.academicProfile?.allowOverCreditSubmissionBy ?? null,
          allowOverCreditSubmissionAt: fullRes.data.academicProfile?.allowOverCreditSubmissionAt ?? prev?.academicProfile?.allowOverCreditSubmissionAt ?? null,
        },
      }));
    } catch (err) {
      setStatusError(err?.response?.data?.error || 'Failed to update status.');
    } finally {
      setStatusLoading(false);
    }
  };

  const handleReclassify = async () => {
    if (!data?.cycle?.id) return;
    setReclassifying(true);
    setReclassifyError('');
    setReclassifySuccess('');
    try {
      const res = await adminReclassifyStudent(studentId, { cohortId, cycleId: data.cycle.id });
      const updatedReqs = res.data?.courseRequests ?? [];
      setData((prev) => ({ ...prev, courseRequests: updatedReqs }));
      const init = {};
      for (const cr of updatedReqs) {
        init[cr.id] = {
          finalClassification: cr.finalClassification,
          finalClassificationReason: cr.finalClassificationReason ?? '',
          saving: false,
          error: '',
        };
      }
      setOverrides(init);
      setReclassifySuccess('Classification refreshed.');
    } catch (err) {
      setReclassifyError(err?.response?.data?.error || 'Reclassification failed.');
    } finally {
      setReclassifying(false);
    }
  };

  const s = data?.student;
  const cycle = data?.cycle;
  const submission = data?.submission;
  const courseRequests = data?.courseRequests ?? [];

  async function handleCreditOverrideToggle(e) {
    const val = e.target.checked;
    // Optimistically write into data so the checkbox reflects the new value immediately
    setData((prev) => ({
      ...prev,
      academicProfile: { ...(prev.academicProfile ?? {}), allowOverCreditSubmission: val },
    }));
    setCreditOverrideSaving(true);
    setCreditOverrideError('');
    setCreditOverrideSaved(false);
    try {
      const res = await saveAdminStudentAcademicProfile(studentId, {
        cohortId,
        allowOverCreditSubmission: val,
        primaryMajorId: data?.academicProfile?.primaryMajor?.programId ?? null,
        additionalMajorIds: (data?.academicProfile?.additionalMajors ?? []).map((m) => m.programId),
        minorIds: (data?.academicProfile?.minors ?? []).map((m) => m.programId),
        catalogYear: data?.academicProfile?.catalogYear ?? null,
      });
      const saved = res.data.profile ?? res.data;
      // Merge server response; enforce the value we sent for the override flag so a
      // snapshot-based GET response can never silently flip it back.
      setData((prev) => ({
        ...prev,
        academicProfile: { ...(prev.academicProfile ?? {}), ...saved, allowOverCreditSubmission: val },
      }));
      setCreditOverrideSaved(true);
      setTimeout(() => setCreditOverrideSaved(false), 2000);
    } catch (err) {
      // Revert optimistic update
      setData((prev) => ({
        ...prev,
        academicProfile: { ...(prev.academicProfile ?? {}), allowOverCreditSubmission: !val },
      }));
      setCreditOverrideError(err?.response?.data?.error || 'Failed to save — please try again.');
    }
    setCreditOverrideSaving(false);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 860, width: '96vw', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>
              Student Review
              {s?.isDummy && (
                <span className="badge badge-removed" style={{ marginLeft: 8, fontSize: 11, verticalAlign: 'middle' }}>Dummy</span>
              )}
            </h2>
            {s && (
              <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4 }}>
                {s.name} · {s.email}
              </div>
            )}
          </div>
          <button className="btn-secondary" style={{ fontSize: 12 }} onClick={onClose} title="Close">✕</button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--color-border)' }}>
          {[['courses', 'Course Requests'], ['degree-plan', 'Degree Plan'], ['degree-flowchart', 'Degree Flowchart']].map(([key, label]) => (
            <button
              key={key} type="button"
              onClick={() => setActiveTab(key)}
              className={activeTab === key ? 'tab-btn active' : 'tab-btn'}
              style={{ fontSize: 13, color: activeTab === key ? 'var(--color-primary,#1a56db)' : 'var(--color-text-muted)' }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {activeTab === 'degree-plan' && (
          <DegreePlanTab studentId={studentId} cohortId={cohortId} academicProfile={data?.academicProfile} onProfileChanged={(profile) => setData((prev) => ({ ...prev, academicProfile: profile }))} />
        )}

        {activeTab === 'degree-flowchart' && (
          <DegreeFlowchartTab studentId={studentId} cohortId={cohortId} academicProfile={data?.academicProfile} />
        )}

        {activeTab === 'courses' && (loading ? (
          <div className="empty-state"><p>Loading…</p></div>
        ) : !data ? null : (
          <>
            {/* Summary row */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--color-border)', fontSize: 13 }}>
              <div style={{ flex: 1, minWidth: 160, padding: '2px 14px 2px 0' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Cycle</div>
                <div style={{ color: 'var(--color-text-muted)' }}>
                  {cycle ? `${cycle.term} (${cycle.termCode})` : <em>None</em>}
                </div>
                {cycle && <div style={{ color: 'var(--color-text-muted)' }}>{cycle.status}</div>}
              </div>
              <div style={{ flex: 2, minWidth: 200, padding: '2px 14px', borderLeft: '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <div style={{ fontWeight: 600 }}>Academic Profile</div>
                  <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 8px', display: 'flex', alignItems: 'center' }} onClick={() => setShowProfileEdit(true)} title="Edit">
                    <img src="/icon-edit.png" alt="Edit" style={{ width: 12, height: 12, objectFit: 'contain' }} />
                  </button>
                </div>
                {data.academicProfile?.primaryMajor ? (
                  <div style={{ color: 'var(--color-text-muted)' }}>
                    <div>{data.academicProfile.primaryMajor.title}{data.academicProfile.primaryMajor.catalog ? ` (${data.academicProfile.primaryMajor.catalog})` : ''}</div>
                    {data.academicProfile.primaryMajor.selectedTrackId && (
                      <div style={{ fontSize: 11, marginTop: 2 }}>Track: {humanizeTrackId(data.academicProfile.primaryMajor.selectedTrackId)}</div>
                    )}
                    {data.academicProfile.additionalMajors?.length > 0 && (
                      <div style={{ fontSize: 11, marginTop: 2 }}>+{data.academicProfile.additionalMajors.map((p) => p.title).join(', ')}</div>
                    )}
                    {data.academicProfile.minors?.length > 0 && (
                      <div style={{ fontSize: 11, marginTop: 2 }}>Minor: {data.academicProfile.minors.map((p) => p.title).join(', ')}</div>
                    )}
                    {(() => {
                      const effectiveTerm = data.academicProfile.effectiveCatalogYear
                        ?? data.academicProfile.catalogYear
                        ?? cohortCatalogYear;
                      if (!effectiveTerm) return null;
                      const displayYear = termToCatalogYear(effectiveTerm) ?? effectiveTerm;
                      const source = data.academicProfile.catalogYearSource
                        ?? (data.academicProfile.catalogYear && data.academicProfile.catalogYear !== cohortCatalogYear
                          ? 'student_override' : 'cohort_default');
                      return (
                        <div style={{ fontSize: 11, marginTop: 2 }}>
                          Catalog year: {displayYear}{' '}
                          <span style={{
                            color: source === 'student_override'
                              ? 'var(--color-primary)'
                              : 'var(--color-text-muted)',
                          }}>
                            ({source === 'student_override' ? 'student override' : 'cohort default'})
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <em style={{ color: 'var(--color-text-muted)' }}>Not selected</em>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 160, padding: '2px 0 2px 14px', borderLeft: '1px solid var(--color-border)' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Submission</div>
                {submission ? (
                  <div>
                    <span className={`badge ${submission.status === 'submitted' ? 'badge-active' : 'badge-expired'}`}>
                      {submission.status}
                    </span>
                    {submission.submittedAt && (
                      <div style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>
                        {new Date(submission.submittedAt).toLocaleString()}
                      </div>
                    )}
                    {submission.lastSubmittedAt && submission.lastSubmittedAt !== submission.submittedAt && (
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 2 }}>
                        Last submitted: {new Date(submission.lastSubmittedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                ) : (
                  <em style={{ color: 'var(--color-text-muted)' }}>No submission</em>
                )}
                {cycle && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      className="btn-secondary btn-sm"
                      style={{ fontSize: 11 }}
                      disabled={statusLoading || submission?.status === 'draft'}
                      onClick={() => handleSetSubmissionStatus('draft')}
                    >
                      Set Draft
                    </button>
                    <button
                      className="btn-primary btn-sm"
                      style={{ fontSize: 11 }}
                      disabled={statusLoading || submission?.status === 'submitted'}
                      onClick={() => handleSetSubmissionStatus('submitted')}
                    >
                      Set Submitted
                    </button>
                  </div>
                )}
                {statusError && <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 4 }}>{statusError}</div>}
              </div>
            </div>

            {/* Credit hour override */}
            <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: creditOverrideSaving ? 'not-allowed' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Boolean(data?.academicProfile?.allowOverCreditSubmission)}
                  onChange={handleCreditOverrideToggle}
                  disabled={creditOverrideSaving}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    Credit hour override
                    {creditOverrideSaving && <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 8 }}>Saving…</span>}
                    {creditOverrideSaved && <span style={{ fontWeight: 400, fontSize: 11, color: '#16a34a', marginLeft: 8 }}>Saved</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                    Allow this student to submit even if Required and Preferred courses total more than 17 credit hours.
                  </div>
                  {creditOverrideError && <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 4 }}>{creditOverrideError}</div>}
                </div>
              </label>
            </div>

            {/* Snapshot / draft-change banners */}
            {data.dataSource === 'snapshot' && (
              <div style={{ padding: '8px 12px', background: '#eff6ff', borderRadius: 6, fontSize: 12, marginBottom: 12, color: '#1e40af' }}>
                <strong>Viewing submitted snapshot</strong>
                {submission?.lastSubmittedAt ? ` — last submitted ${new Date(submission.lastSubmittedAt).toLocaleString()}` : ''}.{' '}
                Live draft changes after this date are not shown here.
              </div>
            )}
            {data.dataSource === 'live' && submission?.status === 'submitted' && (
              <div style={{ padding: '8px 12px', background: '#fefce8', borderRadius: 6, fontSize: 12, marginBottom: 12, color: '#854d0e' }}>
                &#x26A0; No frozen snapshot available — showing live draft data (legacy record or no courses at submit time).
              </div>
            )}
            {submission?.draftUpdatedAfterSubmit && (
              <div style={{ padding: '8px 12px', background: '#fff7ed', borderRadius: 6, fontSize: 12, marginBottom: 12, color: '#9a3412' }}>
                &#x26A0; <strong>Student has unsaved draft changes since their last submission</strong>
                {submission.draftUpdatedAt ? ` (edited ${new Date(submission.draftUpdatedAt).toLocaleString()})` : ''}.{' '}
                These changes are <strong>not visible here</strong> until the student re-submits.
              </div>
            )}

            {/* Course Requests table */}
            <div style={{ fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>Course Requests ({courseRequests.length})</span>
              {courseRequests.length > 0 && (
                <button
                  className="btn-secondary btn-sm"
                  style={{ fontSize: 11, padding: '4px 8px', display: 'flex', alignItems: 'center' }}
                  disabled={reclassifying}
                  onClick={handleReclassify}
                  title="Reclassify Student"
                >
                  {reclassifying ? 'Classifying…' : (
                    <img src="/icon-refresh.png" alt="Reclassify Student" style={{ width: 12, height: 12, objectFit: 'contain' }} />
                  )}
                </button>
              )}
              {reclassifySuccess && <span style={{ fontSize: 11, color: '#16a34a' }}>{reclassifySuccess}</span>}
              {reclassifyError  && <span style={{ fontSize: 11, color: 'var(--color-danger)' }}>{reclassifyError}</span>}
            </div>

            {courseRequests.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>No courses added yet.</p>
            ) : (
              <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface)', borderBottom: '2px solid var(--color-border)' }}>
                      <th style={th}>Course</th>
                      <th style={th}>Title</th>
                      <th style={th}>System</th>
                      <th style={th}>Final Override</th>
                      <th style={th}>Override Reason</th>
                      <th style={th}>Sections</th>
                      <th style={th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {courseRequests.map((cr) => {
                      const ov = overrides[cr.id] ?? { finalClassification: cr.finalClassification, finalClassificationReason: '', saving: false, error: '' };
                      return (
                        <tr key={cr.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                          <td style={{ ...td, fontWeight: 600, fontFamily: 'monospace' }}>
                            {cr.code}
                            {cr.overrideStatus === 'manual_override' && (
                              <span title="Manually overridden" style={{ marginLeft: 4, fontSize: 10, color: 'var(--color-primary)' }}>✎</span>
                            )}
                          </td>
                          <td style={td}>{cr.title || '—'}</td>
                          <td style={td}>
                            <span
                              className={`badge ${cr.systemClassification === 'required' ? 'badge-active' : cr.systemClassification === 'preferred' ? 'badge-pending' : cr.systemClassification === 'not_applied' ? 'badge-removed' : 'badge-default'}`}
                              style={{ fontSize: 10, color: (cr.systemClassification === 'not_applied' || !cr.systemClassification) ? '#1a1a1a' : undefined }}
                              title={cr.classificationReason ?? undefined}
                            >
                              {cr.systemClassification}
                            </span>
                            {cr.classificationWarnings?.length > 0 && (
                              <div style={{ marginTop: 2, fontSize: 10, color: '#b45309' }}>
                                {cr.classificationWarnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                              </div>
                            )}
                            {authUser?.role === 'developer' && cr.classificationEvidence && (
                              <details style={{ marginTop: 4 }}>
                                <summary style={{ fontSize: 10, cursor: 'pointer', color: 'var(--color-text-muted)' }}>Evidence</summary>
                                <pre style={{ fontSize: 9, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--color-surface)', padding: 4, borderRadius: 4, maxWidth: 260, overflowX: 'auto' }}>
                                  {JSON.stringify(cr.classificationEvidence, null, 2)}
                                </pre>
                              </details>
                            )}
                          </td>
                          <td style={{ ...td, minWidth: 130, background: ov.finalClassification !== cr.systemClassification ? '#fef9c3' : undefined }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <span className={`badge ${
                                ov.finalClassification === 'required'   ? 'badge-active'
                                : ov.finalClassification === 'preferred'  ? 'badge-pending'
                                : ov.finalClassification === 'not_applied' ? 'badge-removed'
                                : 'badge-default'
                              }`} style={{ fontSize: 10, flexShrink: 0, whiteSpace: 'nowrap', color: (ov.finalClassification === 'not_applied' || !ov.finalClassification) ? '#1a1a1a' : undefined }}>
                                {ov.finalClassification}
                              </span>
                              <select
                                value={ov.finalClassification}
                                onChange={(e) => handleOverrideChange(cr.id, 'finalClassification', e.target.value)}
                                style={{ fontSize: 11, padding: '2px 4px', flex: 1, minWidth: 0 }}
                              >
                                {CLASSIFICATION_OPTIONS.map((o) => (
                                  <option key={o} value={o}>{o}</option>
                                ))}
                              </select>
                            </div>
                          </td>
                          <td style={{ ...td, minWidth: 160 }}>
                            <input
                              value={ov.finalClassificationReason}
                              onChange={(e) => handleOverrideChange(cr.id, 'finalClassificationReason', e.target.value)}
                              placeholder="Reason (optional)"
                              style={{ fontSize: 11, padding: '2px 4px', width: '100%' }}
                            />
                          </td>
                          <td style={td}>
                            {cr.preferredSections.length > 0 && cr.preferredSections.map((ps) => (
                              <div key={ps.crn} style={{ fontFamily: 'monospace', fontSize: 11 }}>§{ps.section}</div>
                            ))}
                            <button
                              className="btn-secondary btn-sm"
                              style={{ fontSize: 10, padding: '1px 5px', marginTop: cr.preferredSections.length ? 4 : 0 }}
                              onClick={() => setSectionPrefsTarget(cr)}
                            >
                              Manage
                            </button>
                          </td>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              {ov.saving && <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>saving&hellip;</span>}
                              {!ov.saving && ov.saved && <span style={{ fontSize: 10, color: 'var(--color-success,#16a34a)' }}>&#10003;</span>}
                              <button
                                className="btn-danger btn-sm"
                                style={{ fontSize: 10, padding: '2px 6px' }}
                                onClick={() => handleDeleteCourse(cr.id)}
                              >
                                &#x2715;
                              </button>
                            </div>
                            {ov.error && <div style={{ fontSize: 10, color: 'var(--color-danger)' }}>{ov.error}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Add course form */}
            {cycle && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Add Course</div>
                <CourseAutocompleteForm
                  loading={addLoading}
                  onAdd={async ({ subject, number, title }) => {
                    if (!data?.cycle?.id) { setAddError('No cycle loaded.'); return; }
                    const code = `${String(subject).trim().toUpperCase()} ${String(number).trim()}`;
                    if (courseRequests.some((cr) => cr.code === code)) {
                      setAddError(`${code} is already in this student's course list.`);
                      return;
                    }
                    setAddLoading(true);
                    setAddError('');
                    try {
                      const res = await adminAddStudentCourseRequest(studentId, {
                        cohortId,
                        cycleId: data.cycle.id,
                        subject,
                        number,
                        title: title || undefined,
                      });
                      const cr = res.data.request;
                      setData((prev) => ({ ...prev, courseRequests: [...prev.courseRequests, cr] }));
                      setOverrides((prev) => ({
                        ...prev,
                        [cr.id]: { finalClassification: 'unclassified', finalClassificationReason: '', saving: false, error: '' },
                      }));
                    } catch (err) {
                      setAddError(err?.response?.data?.error || 'Failed to add course.');
                    } finally {
                      setAddLoading(false);
                    }
                  }}
                />
                {addError && <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 4 }}>{addError}</div>}
              </div>
            )}
          </>
        ))}
      </div>
      {showProfileEdit && (
        <AcademicProfileEditModal
          studentId={studentId}
          cohortId={cohortId}
          cohortCatalogYear={data?.cohortCatalogYear ?? cohortCatalogYear}
          currentProfile={data?.academicProfile ?? null}
          onClose={() => setShowProfileEdit(false)}
          onSaved={(profile) => {
            setData((prev) => ({ ...prev, academicProfile: profile }));
            setShowProfileEdit(false);
          }}
          onProfileUpdated={(profile) => setData((prev) => ({ ...prev, academicProfile: profile }))}
        />
      )}
      {sectionPrefsTarget && (
        <SectionPrefsEditorModal
          studentId={studentId}
          courseRequest={sectionPrefsTarget}
          termCode={cycle?.termCode ?? null}
          onClose={() => setSectionPrefsTarget(null)}
          onSaved={(requestId, preferredSections) => {
            setData((prev) => ({
              ...prev,
              courseRequests: prev.courseRequests.map((cr) =>
                cr.id === requestId ? { ...cr, preferredSections } : cr
              ),
            }));
            setSectionPrefsTarget(null);
          }}
        />
      )}
    </div>
  );
}

const th = { padding: '6px 8px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap' };
const td = { padding: '6px 8px', verticalAlign: 'middle' };

// ---------------------------------------------------------------------------
// AcademicProfileEditModal
// ---------------------------------------------------------------------------
function AcademicProfileEditModal({ studentId, cohortId, currentProfile, onClose, onSaved, onProfileUpdated, cohortCatalogYear }) {
  useEscapeKey(onClose);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Per-student catalog year override — start at the student's stored override if
  // one exists, otherwise show the cohort default in the dropdown (so admin can
  // see what the student will use and can change it if needed).
  const [catalogYear, setCatalogYear] = useState(
    currentProfile?.catalogYearSource === 'student_override'
      ? (currentProfile.catalogYear ?? cohortCatalogYear ?? '')
      : (cohortCatalogYear ?? '')
  );
  const [secondaryProgramEnabled, setSecondaryProgramEnabled] = useState(
    currentProfile?.secondaryProgramEnabled ?? false
  );

  const isDefault = catalogYear === (cohortCatalogYear ?? '');

  // Auto-save the catalog year immediately on change (just like the secondary
  // program toggle). Does NOT close the modal — calls onProfileUpdated instead.
  const handleCatalogYearChange = async (nextYear) => {
    const prev = catalogYear;
    setCatalogYear(nextYear);
    setSaving(true);
    setError('');
    try {
      const res = await saveAdminStudentAcademicProfile(studentId, {
        cohortId,
        catalogYear: nextYear || null,
        primaryMajorId: currentProfile?.primaryMajor?.programId ?? null,
        additionalMajorIds: (currentProfile?.additionalMajors ?? []).map((m) => m.programId),
        minorIds: (currentProfile?.minors ?? []).map((m) => m.programId),
        secondaryProgramEnabled,
      });
      onProfileUpdated?.(res.data.profile ?? res.data);
    } catch (err) {
      setCatalogYear(prev); // revert on failure
      setError(err?.response?.data?.error || 'Failed to save catalog year.');
    }
    setSaving(false);
  };

  const handleSave = async (data) => {
    setSaving(true);
    setError('');
    try {
      const res = await saveAdminStudentAcademicProfile(studentId, {
        cohortId,
        ...data,
        secondaryProgramEnabled,
        catalogYear: catalogYear || null,
      });
      onSaved(res.data.profile);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to save academic profile.');
      setSaving(false);
    }
  };

  const handleSecondaryProgramToggle = async (e) => {
    const val = e.target.checked;
    setSecondaryProgramEnabled(val);
    setSaving(true);
    setError('');
    try {
      const res = await saveAdminStudentAcademicProfile(studentId, {
        cohortId,
        secondaryProgramEnabled: val,
        primaryMajorId: currentProfile?.primaryMajor?.programId ?? null,
        additionalMajorIds: (currentProfile?.additionalMajors ?? []).map((m) => m.programId),
        minorIds: (currentProfile?.minors ?? []).map((m) => m.programId),
        catalogYear: catalogYear || null,
      });
      // Update parent data without closing the modal.
      onProfileUpdated?.(res.data.profile ?? res.data);
    } catch (err) {
      setSecondaryProgramEnabled(!val); // revert on failure
      setError(err?.response?.data?.error || 'Failed to update secondary program status.');
    }
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>Edit Academic Profile</h2>
          <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onClose}>✕</button>
        </div>
        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        {/* Per-student catalog year override */}
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
            Catalog Year
            {isDefault && cohortCatalogYear && (
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-text-muted)', marginLeft: 6 }}>
                (cohort default)
              </span>
            )}
            {!isDefault && (
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-primary)', marginLeft: 6 }}>
                (overridden for this student)
              </span>
            )}
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select value={catalogYear} onChange={(e) => handleCatalogYearChange(e.target.value)}>
              <option value="">— None —</option>
              {CATALOG_YEAR_OPTIONS.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        <AcademicProfileEditor
          profile={currentProfile}
          cohortCatalogYear={null}
          effectiveCatalogYear={catalogYear || cohortCatalogYear}
          onSave={handleSave}
          saving={saving}
          allowMultipleMajors={true}
        />
      </div>
    </div>
  );
}
