import { useState, useRef, useEffect } from 'react';
import {
  searchCourses,
  getCourseHistory,
  getCourseSections,
  getStudentCohort,
  getCourseRequests,
  addCourseRequest,
  deleteCourseRequest,
  saveSectionPreferences,
} from '../../api';
import ProfessorGpaPanel from '../../components/ProfessorGpaPanel';

const CAMPUS = 'college-station';

export default function StudentSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  const [selectedCourse, setSelectedCourse] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [selectedTerm, setSelectedTerm] = useState(null);
  const [sections, setSections] = useState(null);
  const [gradeStats, setGradeStats] = useState(null);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [sectionsError, setSectionsError] = useState(null);

  // Cohort + active cycle + course requests (loaded on mount)
  const [cohort, setCohort] = useState(null);
  const [activeCycle, setActiveCycle] = useState(null);
  const [courseRequests, setCourseRequests] = useState([]);
  const [initLoading, setInitLoading] = useState(true);

  // Add course
  const [addingCourse, setAddingCourse] = useState(false);
  const [addError, setAddError] = useState(null);

  // Remove course
  const [removingCourse, setRemovingCourse] = useState(false);

  // Section preferences
  const [checkedCrns, setCheckedCrns] = useState(new Set());
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [prefsError, setPrefsError] = useState(null);

  const inputRef = useRef(null);
  const searchTimerRef = useRef(null);
  const searchSeqRef   = useRef(0);

  // Live search — debounced 50 ms; sequence guard prevents stale responses from overwriting newer results
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearchError(null);
      return;
    }
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      const seq = ++searchSeqRef.current;
      setSearching(true);
      setSearchError(null);
      setResults(null);
      setSelectedCourse(null);
      setHistory(null);
      setSections(null);
      setSelectedTerm(null);
      setCheckedCrns(new Set());
      setPrefsSaved(false);
      try {
        const { data } = await searchCourses({ q, campus: CAMPUS });
        if (seq !== searchSeqRef.current) return;
        setResults(data.results ?? []);
      } catch (err) {
        if (seq !== searchSeqRef.current) return;
        setSearchError(err.response?.data?.error ?? 'Search failed. Please try again.');
      } finally {
        if (seq === searchSeqRef.current) setSearching(false);
      }
    }, 50);
    return () => clearTimeout(searchTimerRef.current);
  }, [query]);

  // Load cohort + existing course requests on mount
  useEffect(() => {
    Promise.all([getStudentCohort(), getCourseRequests()])
      .then(([cohortRes, requestsRes]) => {
        setCohort(cohortRes.data.cohort ?? null);
        setActiveCycle(cohortRes.data.activeCycle ?? null);
        setCourseRequests(requestsRes.data.requests ?? []);
      })
      .catch(() => {})
      .finally(() => setInitLoading(false));
  }, []);

  // Current course request (if selected course is in the plan)
  const currentRequest = selectedCourse
    ? courseRequests.find((r) => r.code === selectedCourse.code)
    : null;
  const isInPlan = !!currentRequest;

  async function handleSelectCourse(course) {
    setSelectedCourse(course);
    setSections(null);
    setSelectedTerm(null);
    setSectionsError(null);
    setCheckedCrns(new Set());
    setPrefsSaved(false);
    setAddError(null);
    setPrefsError(null);
    setHistoryLoading(true);
    setHistory(null);

    const autoTerm = activeCycle?.termCode ?? null;

    try {
      const { data } = await getCourseHistory({
        subject: course.subject,
        course: course.courseNumber,
        campus: CAMPUS,
      });
      setHistory(data);
      // Auto-load sections for cohort's term if available, else first history term
      const termToLoad = autoTerm ?? data.terms?.[0]?.termCode ?? null;
      if (termToLoad) {
        setSelectedTerm(termToLoad);
        await loadSections(course, termToLoad);
      }
    } catch {
      setHistory(null);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadSections(course, termCode) {
    if (!course || !termCode) return;
    setSections(null);
    setGradeStats(null);
    setSectionsError(null);
    setSectionsLoading(true);
    try {
      const { data } = await getCourseSections({
        subject: course.subject,
        course: course.courseNumber,
        term: termCode,
      });
      const secs = data.sections ?? [];
      setSections(secs);
      setGradeStats(data.gradeStats ?? null);
      // Pre-check CRNs already saved as preferences
      const req = courseRequests.find((r) => r.code === course.code);
      if (req?.preferredSections?.length > 0) {
        setCheckedCrns(new Set(req.preferredSections.map((p) => p.crn)));
      } else {
        setCheckedCrns(new Set());
      }
    } catch (err) {
      setSectionsError(
        err.response?.data?.error ?? 'Failed to load sections. Howdy may be unavailable.'
      );
    } finally {
      setSectionsLoading(false);
    }
  }

  async function handleLoadSections(termCode) {
    if (!selectedCourse || !termCode) return;
    setSelectedTerm(termCode);
    setPrefsSaved(false);
    await loadSections(selectedCourse, termCode);
  }

  async function handleAddCourse() {
    if (!selectedCourse) return;
    setAddingCourse(true);
    setAddError(null);
    try {
      const { data } = await addCourseRequest({
        subject: selectedCourse.subject,
        number: selectedCourse.courseNumber,
        title: selectedCourse.title,
        college: selectedCourse.college,
        campus: CAMPUS,
      });
      const newReq = data.request;
      setCourseRequests((prev) => {
        const existing = prev.findIndex((r) => r.code === newReq.code);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = newReq;
          return updated;
        }
        return [...prev, newReq];
      });
      // Pre-check existing preferences after add
      if (newReq.preferredSections?.length > 0) {
        setCheckedCrns(new Set(newReq.preferredSections.map((p) => p.crn)));
      }
    } catch (err) {
      setAddError(err.response?.data?.error ?? 'Failed to add course. Please try again.');
    } finally {
      setAddingCourse(false);
    }
  }

  async function handleRemoveCourse() {
    if (!currentRequest) return;
    setRemovingCourse(true);
    try {
      await deleteCourseRequest(currentRequest.id);
      setCourseRequests((prev) => prev.filter((r) => r.id !== currentRequest.id));
      setCheckedCrns(new Set());
      setPrefsSaved(false);
    } catch (err) {
      setAddError(err.response?.data?.error ?? 'Failed to remove course.');
    } finally {
      setRemovingCourse(false);
    }
  }

  function toggleCrn(crn) {
    const next = new Set(checkedCrns);
    if (next.has(crn)) next.delete(crn);
    else next.add(crn);
    setCheckedCrns(next);
    setPrefsSaved(false);
    doSavePrefs(next);
  }

  async function doSavePrefs(crns) {
    if (!currentRequest || !sections) return;
    setSavingPrefs(true);
    setPrefsError(null);
    const selected = sections.filter((s) => crns.has(s.crn));
    const payload = selected.map((s) => ({
      crn: s.crn,
      section: s.section,
      instructorLabel: s.instructors?.join(', ') ?? '',
      meetings: s.meetings ?? [],
    }));
    try {
      const { data } = await saveSectionPreferences(currentRequest.id, payload);
      setCourseRequests((prev) =>
        prev.map((r) =>
          r.id === currentRequest.id
            ? { ...r, preferredSections: data.request?.preferredSections ?? [] }
            : r
        )
      );
      setPrefsSaved(true);
    } catch (err) {
      setPrefsError(err.response?.data?.error ?? 'Failed to save preferences.');
    } finally {
      setSavingPrefs(false);
    }
  }

  const isCohortTerm = selectedTerm && activeCycle?.termCode && selectedTerm === activeCycle.termCode;

  return (
    <>
      <div className="page-header">
        <h1>Course Search</h1>
      </div>

      {/* No active cycle warning */}
      {!initLoading && cohort && !activeCycle && (
        <div
          className="card"
          style={{ marginBottom: 16, borderLeft: '4px solid #d97706', background: '#fffbeb' }}
        >
          <strong style={{ color: '#92400e' }}>⚠ No term code set for this cohort.</strong>
          <span style={{ color: '#92400e', marginLeft: 8, fontSize: 14 }}>
            Course sections cannot be loaded for submission. Contact your program director.
          </span>
        </div>
      )}

      {/* Search bar */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              flex: 1,
              padding: '9px 14px',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 14,
            }}
            placeholder="Search by course code or keyword, such as CSCE 121 or machine learning"
            autoComplete="off"
          />
          <span style={{
            padding: '9px 12px',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 14,
            color: 'var(--color-text-muted)',
            background: 'var(--color-bg-muted, #f9f9f9)',
            whiteSpace: 'nowrap',
          }}>
            College Station
          </span>
          {searching && (
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>Searching…</span>
          )}
        </div>
      </div>

      {searchError && (
        <div className="card" style={{ color: 'var(--color-danger)', marginBottom: 16 }}>
          {searchError}
        </div>
      )}

      {/* Results table */}
      {results !== null && !selectedCourse && (
        <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
          {results.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 20px' }}>
              <p>No courses found for &ldquo;{query}&rdquo;.</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
                  <th style={thStyle}>Code</th>
                  <th style={thStyle}>Title</th>
                  <th style={thStyle}>College</th>
                  <th style={thStyle}>Latest Term</th>
                  <th style={thStyle}>Times Offered</th>
                  <th style={thStyle}>Sections</th>
                  <th style={thStyle}>In Plan</th>
                </tr>
              </thead>
              <tbody>
                {results.map((course) => {
                  const inPlan = courseRequests.some((r) => r.code === course.code);
                  return (
                    <tr
                      key={course.code}
                      style={{ borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}
                      onClick={() => handleSelectCourse(course)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{course.code}</td>
                      <td style={tdStyle}>{course.title}</td>
                      <td style={{ ...tdStyle, color: 'var(--color-text-muted)' }}>{course.college ?? '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--color-text-muted)' }}>{course.latestTermDescription}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>{course.offeringCount}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>{course.sectionsCount}</td>
                      <td style={tdStyle}>
                        {inPlan && <span className="badge badge-active">✓ Added</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Course detail panel */}
      {selectedCourse && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 20 }}>
          {/* History sidebar */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>{selectedCourse.code}</div>
              <button
                className="btn-secondary"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => {
                  setSelectedCourse(null);
                  setSections(null);
                  setHistory(null);
                  setSelectedTerm(null);
                  setCheckedCrns(new Set());
                  setPrefsSaved(false);
                  setAddError(null);
                }}
              >
                <img src="/icon-arrow-left.png" alt="Back" style={{ width: 16, height: 16, objectFit: 'contain', verticalAlign: 'middle' }} />
              </button>
            </div>
            <div style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 8 }}>
              {selectedCourse.title}
            </div>
            <div style={{ fontSize: 13, marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {selectedCourse.college && (
                <span className="badge badge-info">{selectedCourse.college}</span>
              )}
              {(() => {
                const credits = currentRequest?.creditHours ?? (sections && sections.length > 0 ? sections[0].hoursLow : null);
                return credits != null ? (
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{credits} credit{credits !== 1 ? 's' : ''}</span>
                ) : null;
              })()}
            </div>

            {/* Add / In-Plan controls */}
            <div style={{ marginBottom: 16 }}>
              {isInPlan ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span className="badge badge-active">✓ In Your Plan</span>
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ fontSize: 12, padding: '4px 10px', color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
                    onClick={handleRemoveCourse}
                    disabled={removingCourse}
                  >
                    {removingCourse ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              ) : (
                <div>
                  <button
                    className="btn-primary"
                    style={{ width: '100%', fontSize: 13 }}
                    onClick={handleAddCourse}
                    disabled={addingCourse || !cohort || !activeCycle}
                    title="Add to Planned Courses"
                  >
                    {addingCourse ? 'Adding…' : 'Add Course +'}
                  </button>
                  {cohort && !activeCycle && (
                    <div style={{ fontSize: 11, color: '#d97706', marginTop: 4 }}>
                      Admin must set a term code before courses can be added.
                    </div>
                  )}
                  {!cohort && !initLoading && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                      You must be enrolled in a cohort to add courses.
                    </div>
                  )}
                </div>
              )}
              {addError && (
                <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 6 }}>{addError}</div>
              )}
            </div>

            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Offering History</div>
            {historyLoading && <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</div>}
            {!historyLoading && history && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {history.terms.map((term) => (
                  <button
                    key={term.termCode}
                    onClick={() => handleLoadSections(term.termCode)}
                    style={{
                      textAlign: 'left',
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: selectedTerm === term.termCode
                        ? '2px solid var(--color-primary)'
                        : '1px solid var(--color-border)',
                      background: selectedTerm === term.termCode ? '#f1f1f1' : 'transparent',
                      color: 'inherit',
                      fontWeight: selectedTerm === term.termCode ? 600 : 400,
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ display: 'block' }}>
                      {term.termDescription}
                      {term.termCode === cohort?.termCode && (
                        <span style={{
                          marginLeft: 6,
                          fontSize: 10,
                          background: 'var(--color-primary)',
                          color: '#fff',
                          borderRadius: 4,
                          padding: '1px 5px',
                        }}>
                          Your Cohort
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>
                      {term.sectionsCount} section{term.sectionsCount !== 1 ? 's' : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sections panel */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 600, flex: 1 }}>
                {selectedTerm
                  ? `Sections — ${history?.terms?.find((t) => t.termCode === selectedTerm)?.termDescription ?? selectedTerm}`
                  : 'Select a term to view sections'}
              </div>
              {/* Preferred section save status — autosaves on toggle */}
              {isCohortTerm && isInPlan && sections && sections.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {savingPrefs && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Saving…</span>}
                  {prefsSaved && !savingPrefs && <span className="badge badge-active">✓ Saved</span>}
                  {prefsError && <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{prefsError}</span>}
                </div>
              )}
            </div>

            {/* Section-preference info banner */}
            {isCohortTerm && isInPlan && (
              <div style={{ padding: '8px 20px', background: '#f0f9ff', borderBottom: '1px solid #bae6fd', fontSize: 12, color: '#0c4a6e' }}>
                Check any sections you prefer. <strong>Preferred sections are considered when possible. If the course is required, the course still remains part of the scheduling input.</strong> All checked sections are treated equally.
              </div>
            )}
            {isCohortTerm && !isInPlan && (
              <div style={{ padding: '8px 20px', background: '#f0f9ff', borderBottom: '1px solid #bae6fd', fontSize: 12, color: '#0c4a6e' }}>
                Add this course to your plan to save section preferences.
              </div>
            )}
            {selectedTerm && cohort?.termCode && selectedTerm !== cohort.termCode && (
              <div style={{ padding: '8px 20px', background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', fontSize: 12, color: 'var(--color-text-muted)' }}>
                Viewing historical sections (not your cohort's term). Switch to your cohort's term to select preferences.
              </div>
            )}

            {/* Professor GPA summary — historical grade-distribution data for this course */}
            {!sectionsLoading && !sectionsError && sections !== null && sections.length > 0 && (
              <ProfessorGpaPanel gradeStats={gradeStats} />
            )}

            {sectionsLoading && (
              <div style={{ padding: 20, color: 'var(--color-text-muted)', fontSize: 14 }}>Loading sections…</div>
            )}
            {sectionsError && (
              <div style={{ padding: 20, color: 'var(--color-danger)', fontSize: 14 }}>{sectionsError}</div>
            )}
            {!sectionsLoading && !sectionsError && sections !== null && sections.length === 0 && (
              <div className="empty-state" style={{ padding: 32 }}>
                <p>No sections found for this term.</p>
              </div>
            )}
            {!sectionsLoading && !sectionsError && sections !== null && sections.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
                    {isCohortTerm && isInPlan && <th style={thStyle}>Prefer</th>}
                    <th style={thStyle}>CRN</th>
                    <th style={thStyle}>Sec</th>
                    <th style={{ ...thStyle, textAlign: 'center' }}>Credits</th>
                    <th style={thStyle}>Instructor(s)</th>
                    <th style={thStyle}>Days/Times</th>
                    <th style={thStyle}>Location</th>
                    <th style={thStyle}>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map((sec) => (
                    <tr
                      key={sec.crn}
                      style={{
                        borderBottom: '1px solid var(--color-border)',
                        background: isCohortTerm && isInPlan && checkedCrns.has(sec.crn)
                          ? '#f0fdf4'
                          : '',
                      }}
                    >
                      {isCohortTerm && isInPlan && (
                        <td style={{ ...tdStyle, textAlign: 'center', paddingRight: 0 }}>
                          <input
                            type="checkbox"
                            checked={checkedCrns.has(sec.crn)}
                            onChange={() => toggleCrn(sec.crn)}
                            style={{ cursor: 'pointer', width: 16, height: 16 }}
                          />
                        </td>
                      )}
                      <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{sec.crn}</td>
                      <td style={tdStyle}>{sec.section}</td>
                      <td style={{ ...tdStyle, textAlign: 'center', color: 'var(--color-text-muted)' }}>
                        {sec.hoursLow ?? '—'}
                      </td>
                      <td style={tdStyle}>
                        {sec.instructors.length > 0
                          ? sec.instructors.join(', ')
                          : <span style={{ color: 'var(--color-text-muted)' }}>TBA</span>}
                      </td>
                      <td style={tdStyle}>
                        {sec.meetings.length > 0
                          ? sec.meetings.map((m, i) => (
                              <div key={i} style={{ whiteSpace: 'nowrap' }}>
                                {m.days ?? 'TBA'} {m.startTime ?? ''}{m.startTime && m.endTime ? '–' : ''}{m.endTime ?? ''}
                              </div>
                            ))
                          : <span style={{ color: 'var(--color-text-muted)' }}>TBA</span>}
                      </td>
                      <td style={tdStyle}>
                        {sec.meetings.length > 0 && sec.meetings[0].location
                          ? sec.meetings[0].location
                          : <span style={{ color: 'var(--color-text-muted)' }}>TBA</span>}
                      </td>
                      <td style={tdStyle}>
                        {sec.openForRegistration === true && (
                          <span className="badge badge-active" style={{ fontStyle: 'normal' }}>Open</span>
                        )}
                        {sec.openForRegistration === false && (
                          <span className="badge badge-removed" style={{ color: '#1a1a1a', fontStyle: 'normal' }}>Closed</span>
                        )}
                        {sec.openForRegistration === null && (
                          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!selectedTerm && !sectionsLoading && (
              <div style={{ padding: 20, color: 'var(--color-text-muted)', fontSize: 14 }}>
                Click a term on the left to load sections.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Idle state */}
      {results === null && !searching && (
        <div className="empty-state">
          <img src="/icon-search.png" alt="" style={{ width: 52, height: 52, objectFit: 'contain', opacity: 0.35, marginBottom: 8 }} />
          <h3>Search the TAMU Course Catalog</h3>
          <p>
            Enter a course code like <strong>CSCE 121</strong> or a keyword like{' '}
            <strong>machine learning</strong>.
          </p>
        </div>
      )}
    </>
  );
}

const thStyle = {
  padding: '10px 14px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--color-text-muted)',
};

const tdStyle = {
  padding: '10px 14px',
  verticalAlign: 'top',
};
