import { useAuth } from '../../context/AuthContext';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStudentCohort, getStudentSubmission, submitStudentSubmission, getStudentAcademicProfile, deleteCourseRequest, addCourseRequest, getStudentSemesterPlan, reclassifyMyRequests, getCourseSections, saveSectionPreferences } from '../../api';
import ProfessorGpaPanel from '../../components/ProfessorGpaPanel';

export default function StudentDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [cohortData, setCohortData] = useState(null);
  const [submissionData, setSubmissionData] = useState(null);
  const [academicProfile, setAcademicProfile] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submitSuccess, setSubmitSuccess] = useState(null);

  // Course removal
  const [selectedCodes, setSelectedCodes] = useState(new Set());
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState(null);

  // Autopopulate from degree planner
  const [autopopulating, setAutopopulating] = useState(false);
  const [autopopulateError, setAutopopulateError] = useState(null);

  // Reclassify
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyError, setReclassifyError] = useState(null);
  const [reclassifySuccess, setReclassifySuccess] = useState(null);
  const [runWarnings, setRunWarnings] = useState([]);
  // Tracks whether the course list was changed (add/remove) without reclassifying
  const [planChangedSinceClassify, setPlanChangedSinceClassify] = useState(false);
  // Dev-only: evidence inspector
  const [showEvidenceId, setShowEvidenceId] = useState(null);
  // Section preferences modal
  const [sectionPrefsModal, setSectionPrefsModal] = useState(null); // courseRequest object or null

  useEffect(() => {
    Promise.all([getStudentCohort(), getStudentSubmission(), getStudentAcademicProfile().catch(() => ({ data: { profile: null } }))])
      .then(([cohortRes, subRes, profileRes]) => {
        setCohortData(cohortRes.data);
        setSubmissionData(subRes.data);
        setAcademicProfile(profileRes.data.profile ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const cohort = cohortData?.cohort ?? null;
  const activeCycle = cohortData?.activeCycle ?? null;
  const isDevPreview = cohortData?.devPreview === true;
  const submission = submissionData?.submission ?? null;
  const degreePlanSelection = submissionData?.degreePlanSelection ?? null;
  const requests = submissionData?.requests ?? [];

  const canEdit =
    activeCycle &&
    activeCycle.status === 'open' &&
    (!activeCycle.submissionDeadline || new Date() < new Date(activeCycle.submissionDeadline));

  // True if any course has never been classified, or the list changed since the last classify run
  const hasUnclassified = requests.some((r) => !r.classifiedAt);
  // classificationStale comes from the server (persists across page refreshes).
  // planChangedSinceClassify is an in-session supplement for changes made in this browser session
  // before the server-side flag has been confirmed (e.g., mid-session add/remove).
  const serverStale = submission?.classificationStale === true;
  const needsReclassify = hasUnclassified || planChangedSinceClassify || serverStale;

  // Credit-hour limit for submission (Required + Preferred only)
  const SUBMISSION_CREDIT_LIMIT = 17;
  const submissionHours = requests
    .filter((r) => r.finalClassification === 'required' || r.finalClassification === 'preferred')
    .reduce((sum, r) => sum + (Number(r.creditHours) || 0), 0);
  const exceedsCreditLimit = submissionHours > SUBMISSION_CREDIT_LIMIT;
  const creditOverrideActive = academicProfile?.allowOverCreditSubmission === true;
  // overCreditLimit = true only when limit is exceeded AND no admin override is active
  const overCreditLimit = exceedsCreditLimit && !creditOverrideActive;

  const canSubmit = canEdit && (!!degreePlanSelection || !!academicProfile?.primaryMajor?.programId) && requests.length > 0 && !needsReclassify && !overCreditLimit;

  function handleSectionPrefsSaved(requestId, newPrefs) {
    setSubmissionData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        requests: prev.requests.map((r) =>
          String(r.id) === String(requestId) ? { ...r, preferredSections: newPrefs } : r
        ),
      };
    });
    setSectionPrefsModal(null);
  }

  function formatDate(iso) {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  function formatDatetime(iso) {
    if (!iso) return null;
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function statusBadgeClass(status) {
    if (status === 'submitted') return 'badge-active';
    if (status === 'locked') return 'badge-removed';
    return 'badge-pending';
  }

  function toggleSelect(id) {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedCodes.size === requests.length) {
      setSelectedCodes(new Set());
    } else {
      setSelectedCodes(new Set(requests.map((r) => r.id)));
    }
  }

  async function handleRemoveSelected() {
    if (selectedCodes.size === 0) return;
    setRemoving(true);
    setRemoveError(null);
    const ids = [...selectedCodes];
    const failed = [];
    for (const id of ids) {
      try {
        await deleteCourseRequest(id);
      } catch {
        failed.push(id);
      }
    }
    // Refresh submission data
    try {
      const subRes = await getStudentSubmission();
      setSubmissionData(subRes.data);
    } catch {}
    setSelectedCodes(new Set());
    setRemoving(false);
    if (failed.length > 0) {
      setRemoveError(`Failed to remove ${failed.length} course(s). Please try again.`);
    } else {
      // Removed courses may affect classification — require re-classify before submit
      setPlanChangedSinceClassify(true);
    }
  }

  async function handleAutopopulate() {
    if (!activeCycle) {
      setAutopopulateError('No active registration cycle.');
      return;
    }
    if (!window.confirm(
      `This will replace all your currently planned courses with courses from your degree planner for ${activeCycle.term}. Continue?`
    )) return;
    setAutopopulating(true);
    setAutopopulateError(null);
    try {
      const { data } = await getStudentSemesterPlan();
      const semesters = data.semesters ?? [];

      // Build a Season+Year string from the cycle term description (e.g. "Fall 2026 - College Station" → "Fall 2026")
      const cycleMatch = String(activeCycle.term ?? '').match(/^(Fall|Spring|Summer)\s+(\d{4})/i);
      const cycleSeason = cycleMatch?.[1] ?? null;
      const cycleYear   = cycleMatch ? parseInt(cycleMatch[2], 10) : null;

      // Pass 1 — exact termCode
      let sem = semesters.find((s) => s.termCode && s.termCode === activeCycle.termCode);

      // Pass 2 — structured term + year fields
      if (!sem && cycleSeason && cycleYear) {
        sem = semesters.find((s) =>
          String(s.term).toLowerCase() === cycleSeason.toLowerCase() &&
          Number(s.year) === cycleYear
        );
      }

      // Pass 3 — label contains "Season YYYY" (covers old manually-created semesters
      //           where year was not stored separately)
      if (!sem && cycleSeason && cycleYear) {
        const needle = `${cycleSeason} ${cycleYear}`.toLowerCase();
        sem = semesters.find((s) => String(s.label ?? '').toLowerCase().includes(needle));
      }

      if (!sem) {
        const available = semesters.length
          ? semesters.map((s) => s.label || `${s.term} ${s.year ?? ''}`).join(', ')
          : 'none';
        setAutopopulateError(
          `No semester matching "${cycleSeason ?? activeCycle.term} ${cycleYear ?? ''}" found in your degree planner. ` +
          `Available semesters: ${available}.`
        );
        return;
      }
      const plannableCourses = (sem.courses ?? []).filter((c) => c.subject && c.number);
      if (plannableCourses.length === 0) {
        setAutopopulateError('The matching semester in your degree planner has no courses.');
        return;
      }
      for (const r of requests) {
        await deleteCourseRequest(r.id);
      }
      for (const c of plannableCourses) {
        await addCourseRequest({ subject: c.subject, number: c.number, title: c.title ?? '' });
      }
      const subRes = await getStudentSubmission();
      setSubmissionData(subRes.data);
      setSelectedCodes(new Set());
      // Newly imported courses are unclassified — hasUnclassified will catch this,
      // but also set the flag to cover any edge cases.
      setPlanChangedSinceClassify(true);
    } catch (err) {
      setAutopopulateError(err?.response?.data?.error ?? 'Autopopulate failed. Please try again.');
    } finally {
      setAutopopulating(false);
    }
  }

  async function handleReclassify() {
    setReclassifying(true);
    setReclassifyError(null);
    setReclassifySuccess(null);
    try {
      const res = await reclassifyMyRequests();
      const updatedRequests = res.data?.requests ?? [];
      const newRunWarnings = res.data?.runWarnings ?? [];
      setSubmissionData((prev) => ({
        ...prev,
        requests: updatedRequests,
      }));
      setRunWarnings(newRunWarnings);
      setReclassifySuccess('Classification refreshed.');
      setPlanChangedSinceClassify(false);
      // Mirror the server-side stale clearance locally so the submit button enables
      // immediately without a full page reload.
      setSubmissionData((prev) => ({
        ...prev,
        submission: prev?.submission ? { ...prev.submission, classificationStale: false } : prev?.submission,
      }));
    } catch (err) {
      setReclassifyError(err?.response?.data?.error ?? 'Failed to refresh classification.');
    } finally {
      setReclassifying(false);
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(null);
    try {
      const { data } = await submitStudentSubmission();
      setSubmitSuccess(data.message ?? 'Your planned courses have been submitted.');
      // Refresh submission data
      const subRes = await getStudentSubmission();
      setSubmissionData(subRes.data);
    } catch (err) {
      setSubmitError(err.response?.data?.error ?? 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>My Dashboard</h1>
      </div>

      {isDevPreview && (
        <div className="dev-banner" style={{ marginBottom: 16 }}>
          {cohortData?.message}
        </div>
      )}



      {loading ? (
        <div className="card" style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
          Loading your dashboard…
        </div>
      ) : (
        <>
          {/* Info grid — My Cohort | Academic Profile | Courses Planned | Total Hours */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 16, marginBottom: 20 }}>
            {/* My Cohort */}
            <div className="card" style={{ margin: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontWeight: 600 }}>My Cohort</span>
              </div>
              {cohort ? (
                <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                  <div><strong style={{ color: 'inherit' }}>Name:</strong> <span style={{ color: 'var(--color-text)' }}>{cohort.name}</span></div>
                  {activeCycle ? (
                    <div style={{ marginTop: 4 }}>
                      <div><strong style={{ color: 'inherit' }}>Current Cycle:</strong> <span style={{ color: 'var(--color-text)' }}>{activeCycle.term}</span></div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong style={{ color: 'inherit' }}>Term Code:</strong> <code style={{ fontSize: 13 }}>{activeCycle.termCode}</code>
                        <span className={`badge ${cohort.active ? 'badge-active' : 'badge-removed'}`}>
                          {cohort.active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: '#d97706', fontSize: 12, marginTop: 4 }}>⚠ No active registration cycle</div>
                  )}
                </div>
              ) : (
                <div className="empty-state" style={{ padding: '12px 0' }}>
                  <p style={{ fontSize: 13 }}>Not enrolled in a cohort.</p>
                </div>
              )}
            </div>

            {/* Academic Profile */}
            <div className="card" style={{ margin: 0 }}>
              <div style={{ fontWeight: 600, marginBottom: 10 }}>Academic Profile</div>
              {academicProfile?.primaryMajor ? (
                <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                  <div style={{ color: 'var(--color-text)', fontWeight: 500 }}>{academicProfile.primaryMajor.title}</div>
                  {academicProfile.primaryMajor.catalog && <div>Catalog: {academicProfile.primaryMajor.catalog}</div>}
                  {(academicProfile.additionalMajors ?? []).map((p, i) => (
                    <div key={i} style={{ fontSize: 12 }}>+ {p.title}</div>
                  ))}
                  {(academicProfile.minors ?? []).map((p, i) => (
                    <div key={i} style={{ fontSize: 12 }}>Minor: {p.title}</div>
                  ))}
                  {academicProfile.catalogYear && <div>Catalog Year: {academicProfile.catalogYear}</div>}
                </div>
              ) : degreePlanSelection ? (
                <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
                  <div style={{ color: 'var(--color-text)', fontWeight: 500 }}>{degreePlanSelection.planTitle}</div>
                  {degreePlanSelection.catalog && <div>Catalog: {degreePlanSelection.catalog}</div>}
                </div>
              ) : (
                <div className="empty-state" style={{ padding: '12px 0' }}>
                  <p style={{ fontSize: 13 }}>No degree plan selected.</p>
                </div>
              )}
            </div>

            {/* Courses Planned */}
            <div className="stat-card" style={{ margin: 0, alignSelf: 'end' }}>
              <div className="stat-value">{requests.length > 0 ? requests.length : '—'}</div>
              <div className="stat-label">Courses Planned</div>
            </div>
            {/* Total Hours */}
            <div className="stat-card" style={{ margin: 0, alignSelf: 'end' }}>
              <div className="stat-value">
                {requests.length > 0
                  ? requests.reduce((sum, r) => sum + (r.creditHours != null ? Number(r.creditHours) : 0), 0)
                  : '—'}
              </div>
              <div className="stat-label">Total Hours</div>
            </div>
          </div>

          {/* Planned Courses + Submission Status */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 20, alignItems: 'flex-start' }}>
          <div className="card" style={{ flex: 1, minWidth: 0, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>Planned Courses</span>
              {!canEdit && activeCycle?.status === 'closed' && (
                <span style={{ fontSize: 12, color: '#991b1b', background: '#fee2e2', borderRadius: 4, padding: '2px 8px', fontWeight: 600 }}>
                  Submissions closed
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                {canEdit && activeCycle && (
                  <button
                    className="btn-secondary"
                    style={{ padding: '5px 8px', lineHeight: 1, display: 'flex', alignItems: 'center' }}
                    onClick={handleAutopopulate}
                    disabled={autopopulating}
                    title={`Import from Degree Planner (${activeCycle.term})`}
                  >
                    <img src="/icon-import.png" alt="Import from Planner" style={{ width: 15, height: 15, objectFit: 'contain', opacity: autopopulating ? 0.5 : 1 }} />
                  </button>
                )}
                <button
                  className="btn-secondary"
                  style={{ padding: '5px 8px', lineHeight: 1, display: 'flex', alignItems: 'center' }}
                  onClick={() => navigate('/student/search')}
                  title="Course Search"
                >
                  <img src="/icon-search.png" alt="Course Search" style={{ width: 15, height: 15, objectFit: 'contain' }} />
                </button>
                {requests.length > 0 && (
                  <button
                    className="btn-secondary"
                    style={{
                      padding: '5px 8px', lineHeight: 1, display: 'flex', alignItems: 'center',
                      ...(needsReclassify && requests.length > 0
                        ? { background: '#fef3c7', borderColor: '#f59e0b' }
                        : {}),
                    }}
                    disabled={reclassifying}
                    onClick={handleReclassify}
                    title={reclassifying ? 'Classifying…' : 'Refresh Classification'}
                  >
                    <img src="/icon-refresh.png" alt="Refresh Classification" style={{ width: 15, height: 15, objectFit: 'contain', opacity: reclassifying ? 0.5 : 1 }} />
                  </button>
                )}
              </div>
            </div>
            {autopopulateError && (
              <div style={{ padding: '8px 20px', background: '#fef2f2', borderBottom: '1px solid #fecaca', color: '#dc2626', fontSize: 12 }}>
                {autopopulateError}
              </div>
            )}
            {reclassifyError && (
              <div style={{ padding: '8px 20px', background: '#fef2f2', borderBottom: '1px solid #fecaca', color: '#dc2626', fontSize: 12 }}>
                {reclassifyError}
              </div>
            )}
            {reclassifySuccess && (
              <div style={{ margin: '12px 20px 0', padding: '12px 16px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, color: '#14532d', fontSize: 14 }}>
                ✓ {reclassifySuccess}
              </div>
            )}
            {runWarnings.length > 0 && (
              <div style={{ margin: '12px 20px 0', padding: '12px 16px', background: '#eef2f6', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: 14 }}>
                {runWarnings.map((w, i) => (
                  <div key={i} style={{ color: '#475569' }}>&#x26A0; {w}</div>
                ))}
              </div>
            )}
            {selectedCodes.size > 0 && canEdit && (
              <div style={{ padding: '8px 20px', background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                  {selectedCodes.size} course{selectedCodes.size !== 1 ? 's' : ''} selected
                </span>
                <button
                  className="btn-danger btn-sm"
                  style={{ fontSize: 12, display: 'flex', alignItems: 'center', padding: '4px 8px' }}
                  disabled={removing}
                  onClick={handleRemoveSelected}
                  title="Remove selected courses"
                >
                  <img src="/icon-remove.png" alt="Remove selected" style={{ width: 13, height: 13, filter: 'brightness(0) invert(1)', opacity: removing ? 0.5 : 1 }} />
                </button>
                {removeError && <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{removeError}</span>}
              </div>
            )}
            {requests.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px 20px' }}>
                <p>No courses in your plan yet. Use Course Search to add courses.</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
                    {canEdit && (
                      <th style={{ ...thStyle, width: 36, textAlign: 'center', paddingRight: 0 }}>
                        <input
                          type="checkbox"
                          checked={selectedCodes.size === requests.length && requests.length > 0}
                          ref={(el) => { if (el) el.indeterminate = selectedCodes.size > 0 && selectedCodes.size < requests.length; }}
                          onChange={toggleSelectAll}
                          style={{ cursor: 'pointer' }}
                        />
                      </th>
                    )}
                    <th style={thStyle}>Course</th>
                    <th style={{ ...thStyle, width: 40, textAlign: 'center' }}>Hrs</th>
                    <th style={thStyle}>Title</th>
                    <th style={{ ...thStyle, minWidth: 220 }}>Classification</th>
                    <th style={thStyle}>Preferred Sections</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((req) => {
                    const sysClass  = req.systemClassification ?? 'unclassified';
                    const finalClass = req.finalClassification ?? 'unclassified';
                    const isOverridden = req.overrideStatus === 'manual_override';
                    const classBadgeClass = (c) =>
                      c === 'required'    ? 'badge-active'
                      : c === 'preferred'  ? 'badge-pending'
                      : c === 'not_applied' ? 'badge-removed'
                      : 'badge-default';
                    const classLabel = (c) =>
                      c === 'required'     ? 'Required'
                      : c === 'preferred'   ? 'Preferred'
                      : c === 'not_applied' ? 'Not Applied'
                      : 'Unclassified';
                    // Not Applied / Unclassified should read as neutral black, not badge-removed's red.
                    const classBadgeColor = (c) =>
                      (c === 'not_applied' || c === 'unclassified' || !c) ? '#1a1a1a' : undefined;
                    const isPending = finalClass === 'unclassified' && !req.classifiedAt;
                    const ev = req.classificationEvidence ?? {};
                    const evNodes = ev.matchedNodes ?? [];
                    const evColSpan = canEdit ? 6 : 5;
                    return (
                      <>
                      <tr
                        key={req.id}
                        style={{ borderBottom: '1px solid var(--color-border)', background: selectedCodes.has(req.id) ? 'var(--color-surface)' : '' }}
                      >
                        {canEdit && (
                          <td style={{ ...tdStyle, textAlign: 'center', paddingRight: 0, width: 36 }}>
                            <input
                              type="checkbox"
                              checked={selectedCodes.has(req.id)}
                              onChange={() => toggleSelect(req.id)}
                              style={{ cursor: 'pointer' }}
                            />
                          </td>
                        )}
                        <td style={{ ...tdStyle, fontWeight: 600, fontFamily: 'monospace' }}>{req.code}</td>
                        <td style={{ ...tdStyle, width: 40, textAlign: 'center', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                          {req.creditHours != null ? req.creditHours : '—'}
                        </td>
                        <td style={tdStyle}>{req.title ?? '—'}</td>
                        <td style={tdStyle}>
                          {isPending ? (
                            <div>
                              <span className="badge badge-default" style={{ fontSize: 11 }}>Not yet classified</span>
                              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3 }}>
                                Click the refresh icon to classify.
                              </div>
                            </div>
                          ) : (
                            <div>
                              {/* Final classification badge — this is what applies to the student */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span className={`badge ${classBadgeClass(finalClass)}`} style={{ color: classBadgeColor(finalClass) }}>
                                  {classLabel(finalClass)}
                                </span>
                                {/* Show system badge if admin override changed it */}
                                {isOverridden && sysClass !== finalClass && (
                                  <span
                                    className={`badge ${classBadgeClass(sysClass)}`}
                                    style={{ opacity: 0.55, fontSize: 11, color: classBadgeColor(sysClass) }}
                                    title={`Originally classified as: ${classLabel(sysClass)}`}
                                  >
                                    {classLabel(sysClass)}
                                  </span>
                                )}
                                {isOverridden && (
                                  <span style={{ fontSize: 11, color: 'var(--color-primary)', fontStyle: 'italic' }}>
                                    ✎ reviewed
                                  </span>
                                )}
                              </div>
                              {/* Reason */}
                              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.4 }}>
                                {isOverridden && req.finalClassificationReason
                                  ? req.finalClassificationReason
                                  : req.classificationReason ?? ''}
                              </div>
                              {/* Warnings */}
                              {req.classificationWarnings?.length > 0 && (
                                <div style={{ marginTop: 4, fontSize: 11, color: '#b45309' }}>
                                  {req.classificationWarnings.map((w, i) => (
                                    <div key={i}>&#x26A0; {w}</div>
                                  ))}
                                </div>
                              )}
                              {/* Dev-only evidence toggle */}
                              {isDevPreview && (
                                <button
                                  style={{ marginTop: 4, fontSize: 10, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                                  onClick={() => setShowEvidenceId(showEvidenceId === req.id ? null : req.id)}
                                >
                                  {showEvidenceId === req.id ? 'hide evidence' : 'show evidence'}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                            {req.preferredSections && req.preferredSections.length > 0 ? (
                              req.preferredSections.map((ps) => (
                                <span key={ps.crn} style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '1px 6px' }}>
                                  {ps.section || ps.crn}
                                </span>
                              ))
                            ) : (
                              <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>None saved</span>
                            )}
                            {canEdit && (
                              <button
                                className="btn-secondary"
                                style={{ padding: '3px 7px', marginLeft: 2, display: 'flex', alignItems: 'center' }}
                                onClick={() => setSectionPrefsModal(req)}
                                title="Edit Preferred Sections"
                              >
                                <img src="/icon-edit.png" alt="Edit" style={{ width: 11, height: 11, objectFit: 'contain' }} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {/* Dev evidence drawer */}
                      {isDevPreview && showEvidenceId === req.id && (
                        <tr>
                          <td colSpan={evColSpan} style={{ background: '#f5f3ff', borderBottom: '1px solid #ddd6fe', padding: '8px 16px', fontSize: 11, fontFamily: 'monospace' }}>
                            <strong style={{ color: '#4f46e5' }}>&#x1F50D; Evidence for {req.code}</strong>

                            {/* Top-level summary */}
                            <div style={{ marginTop: 4, display: 'grid', gridTemplateColumns: '160px 1fr', gap: '2px 8px' }}>
                              <span style={{ color: '#6b7280' }}>classifier source:</span><span>{ev.source ?? '—'}</span>
                              <span style={{ color: '#6b7280' }}>final decision:</span><span style={{ fontWeight: 700, color: req.systemClassification === 'required' ? '#16a34a' : req.systemClassification === 'preferred' ? '#b45309' : '#6b7280' }}>{req.systemClassification ?? '—'}</span>
                              <span style={{ color: '#6b7280' }}>matched programs:</span><span>{(ev.matchedPrograms ?? []).join(', ') || '(none)'}</span>
                              <span style={{ color: '#6b7280' }}>offering.offered:</span><span>{ev.offering?.offered == null ? 'unknown' : String(ev.offering.offered)}</span>
                              <span style={{ color: '#6b7280' }}>offering.sections:</span><span>{ev.offering?.sectionCount ?? '—'}</span>
                              <span style={{ color: '#6b7280' }}>prereq.eligible:</span><span>{ev.prerequisiteStatus?.eligible == null ? 'unknown' : String(ev.prerequisiteStatus.eligible)}</span>
                              <span style={{ color: '#6b7280' }}>prereq.missing:</span><span>{(ev.prerequisiteStatus?.missingPrereqs ?? []).join(', ') || '—'}</span>
                            </div>

                            {/* Per-program category breakdown */}
                            {Object.values(ev.categoryMatches ?? {}).map((cat) => (
                              <div key={cat.programId} style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #ddd6fe' }}>
                                <div style={{ fontWeight: 700, color: '#4f46e5', marginBottom: 2 }}>
                                  {cat.programTitle ?? cat.programId}
                                  {!cat.hasData && <span style={{ color: '#dc2626', marginLeft: 6 }}>(no data)</span>}
                                </div>
                                {cat.hasData && (
                                  <div style={{ display: 'grid', gridTemplateColumns: '150px 60px 1fr', gap: '1px 6px' }}>
                                    {[
                                      ['exactRequired',  'Exact Required'],
                                      ['pathOption',     'Path Option'],
                                      ['seniorDesign',   'Senior Design'],
                                      ['requiredChoice', 'Required Choice'],
                                      ['pickN',          'Pick-N Pool'],
                                    ].map(([key, label]) => {
                                      const c = cat[key] ?? {};
                                      const hit = c.matched;
                                      const checked = c.checked;
                                      return [
                                        <span key={`l-${key}`} style={{ color: '#6b7280' }}>{label}:</span>,
                                        <span key={`v-${key}`} style={{ color: hit ? '#16a34a' : checked ? '#9ca3af' : '#e5e7eb', fontWeight: hit ? 700 : 400 }}>
                                          {hit ? '✓ HIT' : checked ? 'miss' : 'empty'}
                                        </span>,
                                        <span key={`d-${key}`} style={{ color: '#374151', fontSize: 10 }}>
                                          {hit && c.item ? JSON.stringify(c.item).slice(0, 120) : ''}
                                        </span>,
                                      ];
                                    })}
                                    <span style={{ color: '#6b7280' }}>graphNodeMatch:</span>
                                    <span style={{ color: cat.graphNodeMatch ? '#16a34a' : '#9ca3af' }}>{cat.graphNodeMatch ? 'yes' : 'no'}</span>
                                    <span />
                                  </div>
                                )}
                              </div>
                            ))}

                            {/* Winning matched nodes */}
                            {evNodes.length > 0 && (
                              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #ddd6fe' }}>
                                <strong>Winning matched node(s):</strong>
                                {evNodes.map((n, i) => (
                                  <div key={i} style={{ marginLeft: 8, color: '#374151' }}>
                                    [{n.matchType ?? n.requirementType}] {n.label ?? n.nodeCode ?? n.programId}
                                    {n.pathLabel ? ` — path: "${n.pathLabel}"` : ''}
                                    {n.groupRule  ? ` (${n.groupRule})` : ''}
                                    {n.seminarDowngradeApplied ? ' ⬇ seminar-downgraded' : ''}
                                    {' — '}{n.source ?? ''}
                                  </div>
                                ))}
                              </div>
                            )}

                            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #ddd6fe', color: '#374151' }}>
                              <strong>classifierVersion:</strong> {req.classifierVersion ?? '—'}
                            </div>
                          </td>
                        </tr>
                      )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Deadline + Submission Status — one card, two sections separated by spacing */}
          <div className="card" style={{ width: 240, flexShrink: 0 }}>
            {/* Submission Deadline */}
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Submission Deadline</div>
            {activeCycle ? (
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: activeCycle.submissionDeadline ? '#dc2626' : 'var(--color-text-muted)' }}>
                  {activeCycle.submissionDeadline ? formatDatetime(activeCycle.submissionDeadline) : 'No deadline set'}
                </div>
                {!canEdit && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                    {activeCycle.status === 'closed'
                      ? 'Submissions are closed for this cycle.'
                      : activeCycle.status === 'open'
                      ? 'Deadline has passed'
                      : `Cycle ${activeCycle.status}`}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>No active registration cycle.</div>
            )}

            {/* Submission Status */}
            <div style={{ fontWeight: 600, marginTop: 20, marginBottom: 10 }}>Submission Status</div>
            {submission ? (
              <div>
                <div style={{
                  display: 'inline-block',
                  padding: '7px 16px',
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 15,
                  ...(submission.status === 'submitted'
                    ? { background: 'transparent', border: '2px solid #16a34a', color: '#14532d', fontStyle: 'italic' }
                    : submission.status === 'locked'
                    ? { background: '#fee2e2', border: '2px solid #dc2626', color: '#7f1d1d' }
                    : { background: '#fefce8', border: '2px solid #ca8a04', color: '#713f12' }),
                }}>
                  {submission.status === 'submitted' ? 'Submitted'
                    : submission.status.charAt(0).toUpperCase() + submission.status.slice(1)}
                </div>
                {submission.submittedAt && (
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    <strong style={{ color: 'inherit' }}>Submitted:</strong>{' '}
                    <span style={{ color: 'var(--color-text)' }}>{formatDatetime(submission.submittedAt)}</span>
                  </div>
                )}
                {submission.lastEditedAt && (
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    <strong style={{ color: 'inherit' }}>Last edited:</strong>{' '}
                    <span style={{ color: 'var(--color-text)' }}>{formatDatetime(submission.lastEditedAt)}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty-state" style={{ padding: '12px 0' }}>
                <p style={{ fontSize: 13 }}>No submission yet.</p>
              </div>
            )}
          </div>{/* end right sidebar card */}
          </div>{/* end planned-courses flex row */}

          {/* Submit section */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
              <div style={{ fontWeight: 600 }}>Submit Your Plan</div>
              {requests.length > 0 && !needsReclassify && (
                <div style={{ fontSize: 13, color: overCreditLimit ? '#991b1b' : exceedsCreditLimit ? '#b45309' : 'var(--color-text-muted)' }}>
                  Submission credit hours: <strong style={{ color: overCreditLimit ? '#991b1b' : exceedsCreditLimit ? '#b45309' : 'var(--color-text)' }}>{submissionHours} / {SUBMISSION_CREDIT_LIMIT}</strong>
                  {exceedsCreditLimit && creditOverrideActive && (
                    <span style={{ marginLeft: 6, fontSize: 12, fontWeight: 500 }}>(admin override active)</span>
                  )}
                </div>
              )}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>
              <span style={{ fontWeight: 600 }}>Current Major: </span>
              {academicProfile?.primaryMajor?.title
                ? <span style={{ color: 'var(--color-text)' }}>{academicProfile.primaryMajor.title}</span>
                : <span style={{ fontStyle: 'italic' }}>None selected</span>
              }
            </div>

            {submitSuccess && (
              <div style={{ padding: '12px 16px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, color: '#14532d', fontSize: 14, marginBottom: 14 }}>
                ✓ {submitSuccess}
              </div>
            )}

            {!activeCycle && cohort && (
              <div style={{ padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 14 }}>
                No registration cycle is currently open for your cohort.
              </div>
            )}

            {!canEdit && activeCycle && (
              <div style={{ padding: '12px 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 14 }}>
                The submission deadline has passed.
              </div>
            )}

            {canEdit && (
              <>
                {!degreePlanSelection && !academicProfile?.primaryMajor?.programId && (
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                    &#x26A0; Select a degree plan in the Degree Planner before submitting.
                  </div>
                )}
                {requests.length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                    ⚠ Add at least one course in Course Search before submitting.
                  </div>
                )}
                {requests.length > 0 && needsReclassify && (
                  <div style={{ fontSize: 13, color: '#b45309', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <span>&#x26A0;</span>
                    <span>
                      {hasUnclassified
                        ? 'Some courses have not been classified yet.'
                        : 'Your required/preferred labels may be outdated.'}
                      {' '}Use the refresh icon above before submitting.
                    </span>
                  </div>
                )}
                {overCreditLimit && (
                  <div style={{ fontSize: 13, color: '#991b1b', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <span>&#x26A0;</span>
                    <span>
                      You have <strong>{submissionHours}</strong> credit hours marked Required or Preferred. Students may submit at most <strong>{SUBMISSION_CREDIT_LIMIT}</strong> credit hours unless an admin override is approved.
                    </span>
                  </div>
                )}
                {exceedsCreditLimit && creditOverrideActive && (
                  <div style={{ fontSize: 13, color: '#92400e', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <span>&#x26A0;</span>
                    <span>
                      You have <strong>{submissionHours}</strong> credit hours marked Required or Preferred. An admin override is active, so submission is allowed.
                    </span>
                  </div>
                )}
                {submitError && (
                  <div style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 8 }}>{submitError}</div>
                )}
                <button
                  className="btn-primary"
                  onClick={handleSubmit}
                  disabled={!canSubmit || submitting}
                  style={{ minWidth: 160, marginTop: 8 }}
                >
                  {submitting
                    ? 'Submitting…'
                    : submission?.status === 'submitted'
                    ? 'Resubmit'
                    : 'Submit'}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {sectionPrefsModal && (
        <SectionPrefsModal
          courseRequest={sectionPrefsModal}
          termCode={activeCycle?.termCode ?? null}
          onClose={() => setSectionPrefsModal(null)}
          onSaved={handleSectionPrefsSaved}
        />
      )}
    </>
  );
}

function SectionPrefsModal({ courseRequest, termCode, onClose, onSaved }) {
  const [available, setAvailable] = useState([]);
  const [gradeStats, setGradeStats] = useState(null);
  const [sectionsLoading, setSectionsLoading] = useState(true);
  const [sectionsError, setSectionsError] = useState('');
  const [selected, setSelected] = useState(
    () => new Set((courseRequest.preferredSections ?? []).map((p) => String(p.crn)))
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const availableMap = useRef({});

  useEffect(() => {
    if (!termCode) { setSectionsLoading(false); setSectionsError('No term code for this cycle.'); return; }
    const [subj, num] = courseRequest.code.split(' ');
    setSectionsLoading(true);
    setSectionsError('');
    getCourseSections({ subject: subj, course: num, term: termCode })
      .then((res) => {
        const secs = res.data.sections ?? [];
        setAvailable(secs);
        setGradeStats(res.data.gradeStats ?? null);
        const map = {};
        for (const s of secs) map[String(s.crn)] = s;
        availableMap.current = map;
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
      const existing = (courseRequest.preferredSections ?? []).find((p) => String(p.crn) === crn);
      return existing
        ? { crn, section: existing.section ?? '', instructorLabel: existing.instructorLabel ?? '', meetings: existing.meetings ?? [], termCode }
        : { crn, section: '', instructorLabel: '', meetings: [], termCode };
    });
    try {
      const res = await saveSectionPreferences(courseRequest.id, sections);
      setSaveSuccess(true);
      onSaved(courseRequest.id, res.data.request?.preferredSections ?? []);
    } catch (err) {
      setSaveError(err?.response?.data?.error ?? 'Failed to save.');
      setSaving(false);
    }
  };

  function formatMeetings(meetings) {
    if (!meetings?.length) return null;
    return meetings.map((m) => {
      const time = m.startTime && m.endTime ? ` ${m.startTime}–${m.endTime}` : '';
      const loc = m.location ? ` · ${m.location}` : '';
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

        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
          <strong style={{ color: 'var(--color-text)' }}>Note:</strong> Selected sections will be recorded as your preferred times for this course.
          Leaving all unchecked means any available section may be assigned.
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
