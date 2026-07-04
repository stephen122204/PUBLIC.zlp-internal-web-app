import { useState, useEffect, useCallback } from 'react';
import {
  getDevCohorts,
  getDevStudents,
  getDevStudentContext,
  devUpdateDegreePlan,
  devAddCourseRequest,
  devDeleteCourseRequest,
  devSaveSectionPrefs,
  devSubmit,
  searchCourses,
  getCourseSections,
} from '../../api';

const TABS = ['Overview', 'Degree Plan', 'Planned Courses', 'Section Preferences', 'Submission'];
const CAMPUS_OPTIONS = [
  { value: 'college-station', label: 'College Station' },
  { value: 'galveston', label: 'Galveston' },
  { value: 'qatar', label: 'Qatar' },
  { value: 'all', label: 'All Campuses' },
];

export default function DevStudentPreview() {
  // --- Selector state ---
  const [cohorts, setCohorts] = useState([]);
  const [selectedCohortId, setSelectedCohortId] = useState('');
  const [students, setStudents] = useState([]);
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [loadingCohorts, setLoadingCohorts] = useState(true);
  const [loadingStudents, setLoadingStudents] = useState(false);

  // --- Preview context state ---
  const [context, setContext] = useState(null);
  const [selectedCycleId, setSelectedCycleId] = useState('');
  const [loadingContext, setLoadingContext] = useState(false);
  const [contextError, setContextError] = useState(null);

  // --- Tab state ---
  const [activeTab, setActiveTab] = useState(TABS[0]);

  // --- Degree plan state ---
  const [planFilter, setPlanFilter] = useState('');
  const [savingPlan, setSavingPlan] = useState(false);
  const [planError, setPlanError] = useState(null);

  // --- Course add state ---
  const [courseQuery, setCourseQuery] = useState('');
  const [courseCampus, setCourseCampus] = useState('college-station');
  const [courseResults, setCourseResults] = useState(null);
  const [searchingCourses, setSearchingCourses] = useState(false);
  const [addingCourse, setAddingCourse] = useState(null);
  const [addCourseError, setAddCourseError] = useState(null);

  // --- Section prefs state ---
  const [expandedCourseId, setExpandedCourseId] = useState(null);
  const [loadedSections, setLoadedSections] = useState({}); // courseId → sections[]
  const [loadingSections, setLoadingSections] = useState(null);
  const [checkedCrns, setCheckedCrns] = useState({}); // courseId → Set<crn>
  const [savingPrefs, setSavingPrefs] = useState(null);
  const [prefsError, setPrefsError] = useState(null);

  // --- Submission state ---
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // Load cohorts on mount
  useEffect(() => {
    getDevCohorts()
      .then((res) => setCohorts(res.data.cohorts ?? []))
      .catch(() => setCohorts([]))
      .finally(() => setLoadingCohorts(false));
  }, []);

  // Load students when cohort changes
  useEffect(() => {
    if (!selectedCohortId) {
      setStudents([]);
      setSelectedStudentId('');
      return;
    }
    setLoadingStudents(true);
    setSelectedStudentId('');
    getDevStudents(selectedCohortId)
      .then((res) => setStudents(res.data.students ?? []))
      .catch(() => setStudents([]))
      .finally(() => setLoadingStudents(false));
  }, [selectedCohortId]);

  function handleLoadPreview() {
    if (!selectedCohortId || !selectedStudentId) return;
    setLoadingContext(true);
    setContextError(null);
    setContext(null);
    setActiveTab(TABS[0]);
    setExpandedCourseId(null);
    setLoadedSections({});
    setCheckedCrns({});
    setSubmitSuccess(false);
    setSubmitError(null);
    const params = { cohortId: selectedCohortId };
    if (selectedCycleId) params.cycleId = selectedCycleId;
    getDevStudentContext(selectedStudentId, params)
      .then((res) => {
        const data = res.data;
        setContext(data);
        setSelectedCycleId(data.selectedCycleId ?? '');
        // Pre-populate checkedCrns from loaded section prefs
        const crnsMap = {};
        for (const req of data.courseRequests ?? []) {
          crnsMap[req.id] = new Set((req.preferredSections ?? []).map((s) => s.crn));
        }
        setCheckedCrns(crnsMap);
      })
      .catch((err) => setContextError(err?.response?.data?.error ?? 'Failed to load student context.'))
      .finally(() => setLoadingContext(false));
  }

  // Reload context with current cycleId (after mutations)
  const reloadContext = useCallback(() => {
    if (!selectedCohortId || !selectedStudentId) return;
    const params = { cohortId: selectedCohortId };
    if (selectedCycleId) params.cycleId = selectedCycleId;
    getDevStudentContext(selectedStudentId, params)
      .then((res) => {
        const data = res.data;
        setContext(data);
        const crnsMap = {};
        for (const req of data.courseRequests ?? []) {
          crnsMap[req.id] = new Set((req.preferredSections ?? []).map((s) => s.crn));
        }
        setCheckedCrns(crnsMap);
      })
      .catch(() => {});
  }, [selectedCohortId, selectedStudentId, selectedCycleId]);

  // --- Degree Plan ---
  async function handleSavePlan(planId) {
    if (!context) return;
    const plan = (context.degreePlans ?? []).find((p) => p.id === planId);
    setSavingPlan(true);
    setPlanError(null);
    try {
      await devUpdateDegreePlan(context.student.id, {
        cohortId: selectedCohortId,
        planId,
        planTitle: plan?.title ?? planId,
        catalog: plan?.catalog ?? null,
      });
      reloadContext();
    } catch (err) {
      setPlanError(err?.response?.data?.error ?? 'Failed to save degree plan.');
    } finally {
      setSavingPlan(false);
    }
  }

  // --- Course search ---
  async function handleCourseSearch(e) {
    e.preventDefault();
    const q = courseQuery.trim();
    if (!q) return;
    setSearchingCourses(true);
    setAddCourseError(null);
    try {
      const res = await searchCourses({ q, campus: courseCampus });
      setCourseResults(res.data.results ?? []);
    } catch {
      setCourseResults([]);
    } finally {
      setSearchingCourses(false);
    }
  }

  async function handleAddCourse(course) {
    if (!context || !selectedCycleId) return;
    setAddingCourse(course.code);
    setAddCourseError(null);
    try {
      await devAddCourseRequest(context.student.id, {
        cohortId: selectedCohortId,
        cycleId: selectedCycleId,
        subject: course.subject,
        number: course.number,
        title: course.title ?? '',
        college: course.college ?? '',
        campus: courseCampus === 'all' ? 'college-station' : courseCampus,
      });
      reloadContext();
    } catch (err) {
      setAddCourseError(err?.response?.data?.error ?? 'Failed to add course.');
    } finally {
      setAddingCourse(null);
    }
  }

  async function handleRemoveCourse(requestId) {
    if (!context || !selectedCycleId) return;
    try {
      await devDeleteCourseRequest(context.student.id, requestId, {
        cohortId: selectedCohortId,
        cycleId: selectedCycleId,
      });
      reloadContext();
    } catch (err) {
      console.error('Remove course error:', err);
    }
  }

  // --- Section preferences ---
  async function handleExpandCourse(req) {
    if (expandedCourseId === req.id) {
      setExpandedCourseId(null);
      return;
    }
    setExpandedCourseId(req.id);
    if (loadedSections[req.id]) return;
    if (!context?.selectedCycleId) return;
    const cycle = (context.allCycles ?? []).find(
      (c) => c.id === (selectedCycleId || context.selectedCycleId)
    );
    if (!cycle?.termCode) return;
    setLoadingSections(req.id);
    try {
      const res = await getCourseSections({
        subject: req.subject,
        course: req.number,
        term: cycle.termCode,
      });
      setLoadedSections((prev) => ({ ...prev, [req.id]: res.data.sections ?? [] }));
    } catch {
      setLoadedSections((prev) => ({ ...prev, [req.id]: [] }));
    } finally {
      setLoadingSections(null);
    }
  }

  function toggleCrn(courseId, section) {
    setCheckedCrns((prev) => {
      const existing = new Set(prev[courseId] ?? []);
      const key = section.crn;
      if (existing.has(key)) existing.delete(key);
      else existing.add(key);
      return { ...prev, [courseId]: existing };
    });
  }

  async function handleSavePrefs(req) {
    if (!context || !selectedCycleId) return;
    setSavingPrefs(req.id);
    setPrefsError(null);
    try {
      const sections = (loadedSections[req.id] ?? [])
        .filter((s) => checkedCrns[req.id]?.has(s.crn))
        .map((s) => ({
          crn: s.crn,
          section: s.section ?? '',
          instructorLabel: s.instructorLabel ?? s.instructor ?? '',
          meetings: s.meetings ?? [],
        }));
      await devSaveSectionPrefs(req.id, req.id, {
        cohortId: selectedCohortId,
        cycleId: selectedCycleId,
        sections,
      });
      reloadContext();
    } catch (err) {
      setPrefsError(err?.response?.data?.error ?? 'Failed to save preferences.');
    } finally {
      setSavingPrefs(null);
    }
  }

  // --- Submission ---
  async function handleSubmit(force = false) {
    if (!context || !selectedCycleId) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(false);
    try {
      await devSubmit(context.student.id, {
        cohortId: selectedCohortId,
        cycleId: selectedCycleId,
        force,
      });
      setSubmitSuccess(true);
      reloadContext();
    } catch (err) {
      setSubmitError(err?.response?.data?.error ?? 'Failed to submit.');
    } finally {
      setSubmitting(false);
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  const activeCycleObj = context
    ? (context.allCycles ?? []).find((c) => c.id === (selectedCycleId || context.selectedCycleId))
    : null;

  return (
    <div className="page-container">
      {/* Developer mode banner */}
      <div
        style={{
          background: '#1a1a2e',
          color: '#e2e8f0',
          padding: '8px 16px',
          borderRadius: 6,
          marginBottom: 16,
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>&#128295;</span>
        <strong>Developer Preview</strong>
        <span style={{ color: '#94a3b8' }}>
          — You are viewing student data for testing and support. Your role has not changed.
        </span>
      </div>

      <h1 className="page-title">Developer Student Preview</h1>

      {/* --- Selectors --- */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          marginBottom: 24,
          padding: '16px',
          background: 'var(--surface)',
          borderRadius: 8,
          border: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Cohort</label>
          <select
            value={selectedCohortId}
            onChange={(e) => {
              setSelectedCohortId(e.target.value);
              setContext(null);
            }}
            disabled={loadingCohorts}
          >
            <option value="">— Select a cohort —</option>
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.term ? ` — ${c.term}` : ''}{c.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Student</label>
          <select
            value={selectedStudentId}
            onChange={(e) => {
              setSelectedStudentId(e.target.value);
              setContext(null);
            }}
            disabled={!selectedCohortId || loadingStudents}
          >
            <option value="">— Select a student —</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.email})
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn-primary"
          onClick={handleLoadPreview}
          disabled={!selectedCohortId || !selectedStudentId || loadingContext}
        >
          {loadingContext ? 'Loading…' : 'Load Preview'}
        </button>
      </div>

      {contextError && (
        <div className="error-message" style={{ marginBottom: 16 }}>
          {contextError}
        </div>
      )}

      {/* --- Context loaded --- */}
      {context && (
        <>
          {/* Cycle selector (shown after load) */}
          {context.allCycles?.length > 1 && (
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>Cycle:</label>
              <select
                value={selectedCycleId || context.selectedCycleId || ''}
                onChange={(e) => {
                  setSelectedCycleId(e.target.value);
                  const params = { cohortId: selectedCohortId, cycleId: e.target.value };
                  setLoadingContext(true);
                  getDevStudentContext(context.student.id, params)
                    .then((res) => {
                      setContext(res.data);
                      const crnsMap = {};
                      for (const req of res.data.courseRequests ?? []) {
                        crnsMap[req.id] = new Set((req.preferredSections ?? []).map((s) => s.crn));
                      }
                      setCheckedCrns(crnsMap);
                      setExpandedCourseId(null);
                      setLoadedSections({});
                    })
                    .catch(() => {})
                    .finally(() => setLoadingContext(false));
                }}
              >
                {context.allCycles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.term ?? c.termCode} — {c.status}
                    {c.activeForStudents ? ' (active)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '2px solid var(--border)' }}>
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '8px 16px',
                  background: 'none',
                  border: 'none',
                  borderBottom: activeTab === tab ? '2px solid var(--primary)' : '2px solid transparent',
                  marginBottom: -2,
                  fontWeight: activeTab === tab ? 700 : 400,
                  color: activeTab === tab ? 'var(--primary)' : 'var(--text)',
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* --- Overview Tab --- */}
          {activeTab === 'Overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <section style={{ padding: 16, background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Student Info</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 14 }}>
                  <div><span style={{ color: 'var(--muted)' }}>Name:</span> {context.student.name}</div>
                  <div><span style={{ color: 'var(--muted)' }}>Email:</span> {context.student.email}</div>
                  <div><span style={{ color: 'var(--muted)' }}>Cohort:</span> {context.cohort.name}{context.cohort.term ? ` — ${context.cohort.term}` : ''}</div>
                  <div><span style={{ color: 'var(--muted)' }}>Cohort Status:</span> {context.cohort.active ? 'Active' : 'Archived'}</div>
                </div>
              </section>
              <section style={{ padding: 16, background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Current Cycle</h3>
                {activeCycleObj ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 14 }}>
                    <div><span style={{ color: 'var(--muted)' }}>Term:</span> {activeCycleObj.term ?? activeCycleObj.termCode}</div>
                    <div><span style={{ color: 'var(--muted)' }}>Status:</span> {activeCycleObj.status}</div>
                    {activeCycleObj.submissionDeadline && (
                      <div><span style={{ color: 'var(--muted)' }}>Deadline:</span> {new Date(activeCycleObj.submissionDeadline).toLocaleString()}</div>
                    )}
                    <div><span style={{ color: 'var(--muted)' }}>Can Edit:</span> {context.canEdit ? 'Yes' : 'No (deadline passed)'}</div>
                  </div>
                ) : (
                  <p style={{ color: 'var(--muted)', fontSize: 14 }}>No cycle selected.</p>
                )}
              </section>
              <section style={{ padding: 16, background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Submission Status</h3>
                {context.submission ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 14 }}>
                    <div><span style={{ color: 'var(--muted)' }}>Status:</span> <strong>{context.submission.status}</strong></div>
                    {context.submission.submittedAt && (
                      <div><span style={{ color: 'var(--muted)' }}>Submitted:</span> {new Date(context.submission.submittedAt).toLocaleString()}</div>
                    )}
                    {context.submission.lastEditedAt && (
                      <div><span style={{ color: 'var(--muted)' }}>Last edited:</span> {new Date(context.submission.lastEditedAt).toLocaleString()}</div>
                    )}
                  </div>
                ) : (
                  <p style={{ color: 'var(--muted)', fontSize: 14 }}>No submission yet for this cycle.</p>
                )}
              </section>
              <section style={{ padding: 16, background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Degree Plan</h3>
                {context.degreePlanSelection ? (
                  <div style={{ fontSize: 14 }}>
                    <div><span style={{ color: 'var(--muted)' }}>Selected plan:</span> {context.degreePlanSelection.planTitle}</div>
                    {context.degreePlanSelection.catalog && (
                      <div><span style={{ color: 'var(--muted)' }}>Catalog:</span> {context.degreePlanSelection.catalog}</div>
                    )}
                  </div>
                ) : (
                  <p style={{ color: 'var(--muted)', fontSize: 14 }}>No degree plan selected.</p>
                )}
              </section>
              <section style={{ padding: 16, background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Planned Courses ({context.courseRequests?.length ?? 0})</h3>
                {(context.courseRequests?.length ?? 0) === 0 ? (
                  <p style={{ color: 'var(--muted)', fontSize: 14 }}>No courses added yet.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {context.courseRequests.map((r) => (
                      <div key={r.id} style={{ fontSize: 14 }}>
                        <strong>{r.code}</strong> — {r.title || '(no title)'}
                        <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12 }}>
                          {(r.preferredSections?.length ?? 0)} preferred section(s)
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* --- Degree Plan Tab --- */}
          {activeTab === 'Degree Plan' && (
            <div>
              <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Filter plans…"
                  value={planFilter}
                  onChange={(e) => setPlanFilter(e.target.value)}
                  style={{ flex: 1 }}
                />
              </div>
              {context.degreePlanSelection && (
                <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
                  Currently selected: <strong>{context.degreePlanSelection.planTitle}</strong>
                  {context.degreePlanSelection.catalog ? ` (${context.degreePlanSelection.catalog})` : ''}
                </p>
              )}
              {planError && <div className="error-message" style={{ marginBottom: 12 }}>{planError}</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 480, overflowY: 'auto' }}>
                {(context.degreePlans ?? [])
                  .filter((p) => {
                    const q = planFilter.toLowerCase();
                    return !q || p.title?.toLowerCase().includes(q) || p.catalog?.toLowerCase().includes(q);
                  })
                  .map((plan) => {
                    const isSelected = context.degreePlanSelection?.planId === plan.id;
                    return (
                      <div
                        key={plan.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 14px',
                          borderRadius: 6,
                          border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                          background: isSelected ? 'var(--primary-light, #eff6ff)' : 'var(--surface)',
                          fontSize: 14,
                        }}
                      >
                        <div>
                          <strong>{plan.title}</strong>
                          {plan.catalog && <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12 }}>{plan.catalog}</span>}
                          {isSelected && <span style={{ marginLeft: 8, color: 'var(--primary)', fontSize: 12, fontWeight: 700 }}>✓ Selected</span>}
                        </div>
                        {!isSelected && (
                          <button
                            className="btn-secondary btn-sm"
                            disabled={savingPlan}
                            onClick={() => handleSavePlan(plan.id)}
                          >
                            Select
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* --- Planned Courses Tab --- */}
          {activeTab === 'Planned Courses' && (
            <div>
              {!selectedCycleId && (
                <div className="error-message" style={{ marginBottom: 12 }}>No scheduling cycle selected. Please load a preview with an active cycle.</div>
              )}

              {/* Search */}
              <form onSubmit={handleCourseSearch} style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="Search courses (e.g. CSCE 121)"
                  value={courseQuery}
                  onChange={(e) => setCourseQuery(e.target.value)}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <select value={courseCampus} onChange={(e) => setCourseCampus(e.target.value)}>
                  {CAMPUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button className="btn-primary" type="submit" disabled={searchingCourses || !selectedCycleId}>
                  {searchingCourses ? 'Searching…' : 'Search'}
                </button>
              </form>

              {addCourseError && <div className="error-message" style={{ marginBottom: 12 }}>{addCourseError}</div>}

              {courseResults !== null && (
                <div style={{ marginBottom: 20, maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                  {courseResults.length === 0 ? (
                    <p style={{ padding: 12, color: 'var(--muted)', fontSize: 14 }}>No results found.</p>
                  ) : (
                    courseResults.map((c) => {
                      const alreadyAdded = (context.courseRequests ?? []).some((r) => r.code === c.code);
                      return (
                        <div
                          key={c.code}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '8px 12px',
                            borderBottom: '1px solid var(--border)',
                            fontSize: 13,
                          }}
                        >
                          <div>
                            <strong>{c.code}</strong> — {c.title}
                          </div>
                          <button
                            className="btn-secondary btn-sm"
                            disabled={alreadyAdded || addingCourse === c.code || !selectedCycleId}
                            onClick={() => handleAddCourse(c)}
                            title="Add"
                          >
                            {alreadyAdded ? 'Added' : addingCourse === c.code ? 'Adding…' : <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1 }}>+</span>}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* Current courses */}
              <h3 style={{ fontSize: 15, marginBottom: 10 }}>
                Planned Courses ({context.courseRequests?.length ?? 0})
              </h3>
              {(context.courseRequests?.length ?? 0) === 0 ? (
                <p style={{ color: 'var(--muted)', fontSize: 14 }}>No courses added for this cycle.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {context.courseRequests.map((r) => (
                    <div
                      key={r.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 14px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                        fontSize: 14,
                      }}
                    >
                      <div>
                        <strong>{r.code}</strong>
                        {r.title && <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{r.title}</span>}
                        <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12 }}>
                          {(r.preferredSections?.length ?? 0)} preferred section(s)
                        </span>
                      </div>
                      <button
                        className="btn-danger btn-sm"
                        style={{ marginLeft: 8 }}
                        onClick={() => handleRemoveCourse(r.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* --- Section Preferences Tab --- */}
          {activeTab === 'Section Preferences' && (
            <div>
              {(context.courseRequests?.length ?? 0) === 0 ? (
                <p style={{ color: 'var(--muted)', fontSize: 14 }}>No planned courses. Add courses first.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {context.courseRequests.map((req) => {
                    const isExpanded = expandedCourseId === req.id;
                    const sections = loadedSections[req.id] ?? [];
                    const checked = checkedCrns[req.id] ?? new Set();
                    return (
                      <div key={req.id} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                        <button
                          onClick={() => handleExpandCourse(req)}
                          style={{
                            width: '100%',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '12px 16px',
                            background: 'var(--surface)',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 14,
                            textAlign: 'left',
                          }}
                        >
                          <span>
                            <strong>{req.code}</strong>
                            {req.title && <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{req.title}</span>}
                            <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--muted)' }}>
                              {checked.size} preferred
                            </span>
                          </span>
                          <span style={{ color: 'var(--muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                        </button>
                        {isExpanded && (
                          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
                            {loadingSections === req.id ? (
                              <p style={{ fontSize: 13, color: 'var(--muted)' }}>Loading sections…</p>
                            ) : sections.length === 0 ? (
                              <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                                No sections available for this term.
                              </p>
                            ) : (
                              <>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12, maxHeight: 320, overflowY: 'auto' }}>
                                  {sections.map((s) => (
                                    <label
                                      key={s.crn}
                                      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 13, padding: '6px 8px', borderRadius: 4, background: checked.has(s.crn) ? 'var(--primary-light, #eff6ff)' : 'transparent' }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked.has(s.crn)}
                                        onChange={() => toggleCrn(req.id, s)}
                                        style={{ marginTop: 2 }}
                                      />
                                      <div>
                                        <div>
                                          <strong>Sec {s.section ?? s.crn}</strong>
                                          {s.instructorLabel && <span style={{ marginLeft: 6, color: 'var(--muted)' }}>{s.instructorLabel}</span>}
                                          <span style={{ marginLeft: 6, color: 'var(--muted)', fontSize: 12 }}>CRN {s.crn}</span>
                                        </div>
                                        {s.meetings?.length > 0 && (
                                          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                                            {s.meetings.map((m, i) => (
                                              <span key={i}>{m.days} {m.time} {m.location ? `@ ${m.location}` : ''}{i < s.meetings.length - 1 ? '; ' : ''}</span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </label>
                                  ))}
                                </div>
                                {prefsError && expandedCourseId === req.id && (
                                  <div className="error-message" style={{ marginBottom: 8 }}>{prefsError}</div>
                                )}
                                <button
                                  className="btn-primary btn-sm"
                                  disabled={savingPrefs === req.id}
                                  onClick={() => handleSavePrefs(req)}
                                >
                                  {savingPrefs === req.id ? 'Saving…' : 'Save Preferences'}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* --- Submission Tab --- */}
          {activeTab === 'Submission' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <section style={{ padding: 16, background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Current Submission</h3>
                {context.submission ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 14 }}>
                    <div><span style={{ color: 'var(--muted)' }}>Status:</span> <strong>{context.submission.status}</strong></div>
                    {context.submission.submittedAt && (
                      <div><span style={{ color: 'var(--muted)' }}>Submitted:</span> {new Date(context.submission.submittedAt).toLocaleString()}</div>
                    )}
                    {context.submission.lastEditedAt && (
                      <div><span style={{ color: 'var(--muted)' }}>Last edited:</span> {new Date(context.submission.lastEditedAt).toLocaleString()}</div>
                    )}
                  </div>
                ) : (
                  <p style={{ color: 'var(--muted)', fontSize: 14 }}>No submission yet for this cycle.</p>
                )}
              </section>

              {submitError && <div className="error-message">{submitError}</div>}
              {submitSuccess && (
                <div className="success-message" style={{ padding: '10px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, color: '#15803d', fontSize: 14 }}>
                  Submission updated successfully.
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  className="btn-primary"
                  disabled={submitting || !selectedCycleId}
                  onClick={() => handleSubmit(false)}
                >
                  {submitting ? 'Submitting…' : context.submission?.status === 'submitted' ? 'Resubmit' : 'Submit'}
                </button>
                <button
                  className="btn-secondary"
                  disabled={submitting || !selectedCycleId}
                  onClick={() => handleSubmit(true)}
                  title="Force submit bypasses degree plan and course requirement checks"
                >
                  Force Submit (skip validation)
                </button>
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                Force Submit bypasses the degree plan and course requirement checks. Use for testing only.
              </p>
            </div>
          )}
        </>
      )}

      {!context && !loadingContext && !contextError && (
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>
          Select a cohort and student, then click Load Preview to begin.
        </p>
      )}
    </div>
  );
}
