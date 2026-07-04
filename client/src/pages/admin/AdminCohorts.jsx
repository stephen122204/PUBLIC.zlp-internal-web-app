import { useState, useEffect, useCallback, useRef } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import {
  getCohorts,
  createCohort,
  reorderCohorts,
  updateCohort,
  archiveCohort,
  unarchiveCohort,
  getTermOptions,
  getCyclesForCohort,
  createSchedulingCycle,
  updateSchedulingCycle,
  activateCycle,
  closeCycle,
  deleteSchedulingCycle,
  adminReclassifyCohortCycle,
} from '../../api';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Catalog year options — semester terms, last 5 years from current year
// ---------------------------------------------------------------------------
const _CY = new Date().getFullYear();
const CATALOG_YEAR_OPTIONS = [];
for (let y = _CY - 4; y <= _CY; y++) {
  CATALOG_YEAR_OPTIONS.push(`Fall ${y}`, `Spring ${y + 1}`, `Summer ${y + 1}`);
}

// ---------------------------------------------------------------------------
// Create Cohort Modal — name + catalog year
// ---------------------------------------------------------------------------
function CreateCohortModal({ onClose, onCreated }) {
  useEscapeKey(onClose);
  const [name, setName] = useState('');
  const [catalogYear, setCatalogYear] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await createCohort({ name: name.trim(), catalogYear: catalogYear || null });
      onCreated(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create cohort.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create Cohort</h2>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label>Cohort Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ZLP Cohort J"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Catalog Year</label>
            <select value={catalogYear} onChange={(e) => setCatalogYear(e.target.value)}>
              <option value="">— None —</option>
              {CATALOG_YEAR_OPTIONS.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Creating…' : 'Create Cohort'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit Cohort Modal — name, active toggle
// ---------------------------------------------------------------------------
function EditCohortModal({ cohort, onClose, onUpdated, onArchived, onUnarchived }) {
  useEscapeKey(onClose);
  const isArchived = !!cohort.archivedAt;
  const [form, setForm] = useState({
    name: cohort.name ?? '',
    catalogYear: cohort.catalogYear ?? '',
  });
  const [loading, setLoading] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [unarchiving, setUnarchiving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await updateCohort(cohort._id, form);
      onUpdated(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to update cohort.');
    } finally {
      setLoading(false);
    }
  };

  const handleArchive = async () => {
    setArchiving(true);
    setError('');
    try {
      const res = await archiveCohort(cohort._id);
      onArchived(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to archive cohort.');
    } finally {
      setArchiving(false);
    }
  };

  const handleUnarchive = async () => {
    setUnarchiving(true);
    setError('');
    try {
      const res = await unarchiveCohort(cohort._id);
      onUnarchived(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to unarchive cohort.');
    } finally {
      setUnarchiving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit Cohort</h2>
        {error && <div className="alert alert-error">{error}</div>}
        {isArchived && (
          <div className="alert alert-info" style={{ marginBottom: 8 }}>
            This cohort is archived. Unarchive it to make edits.
          </div>
        )}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label>Cohort Name *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={isArchived} />
          </div>
          <div className="form-group">
            <label>Catalog Year</label>
            <select value={form.catalogYear} onChange={(e) => setForm({ ...form, catalogYear: e.target.value })} disabled={isArchived}>
              <option value="">— None —</option>
              {CATALOG_YEAR_OPTIONS.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            {!isArchived && (
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </form>
        <hr style={{ margin: '20px 0', borderColor: 'var(--color-border, #e5e7eb)' }} />
        {isArchived ? (
          <div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 8 }}>
              Unarchiving restores this cohort to the default view and re-enables invites and
              scheduling cycles.
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={handleUnarchive}
              disabled={unarchiving}
            >
              {unarchiving ? 'Unarchiving…' : 'Unarchive Cohort'}
            </button>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 8 }}>
              Archiving hides this cohort from the default view and blocks new invites and scheduling
              cycles. All student data, submissions, and history are preserved.
            </div>
            {!confirmArchive ? (
              <button
                type="button"
                className="btn-secondary"
                style={{ color: 'var(--color-danger, #dc2626)', borderColor: 'var(--color-danger, #dc2626)' }}
                onClick={() => setConfirmArchive(true)}
              >
                Archive Cohort…
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--color-danger, #dc2626)', fontWeight: 600 }}>
                  Archive "{cohort.name}"?
                </span>
                <button
                  type="button"
                  className="btn-primary"
                  style={{ background: 'var(--color-danger, #dc2626)', borderColor: 'var(--color-danger, #dc2626)' }}
                  onClick={handleArchive}
                  disabled={archiving}
                >
                  {archiving ? 'Archiving…' : 'Yes, Archive'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setConfirmArchive(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit Cycle Modal
// ---------------------------------------------------------------------------
function CycleModal({ cohortId, cycle, termOptions, onClose, onSaved, onDeleted }) {
  useEscapeKey(onClose);
  const isEdit = !!cycle;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState({
    termCode: cycle?.termCode ?? '',
    term: cycle?.term ?? '',
    submissionOpenAt: cycle?.submissionOpenAt
      ? new Date(cycle.submissionOpenAt).toISOString().slice(0, 16)
      : '',
    submissionDeadline: cycle?.submissionDeadline
      ? new Date(cycle.submissionDeadline).toISOString().slice(0, 16)
      : '',
    status: cycle?.status ?? 'draft',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      await deleteSchedulingCycle(cycle._id);
      onDeleted(cycle._id);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to delete cycle.');
      setDeleting(false);
    }
  };

  const handleTermChange = (e) => {
    const opt = termOptions.find((t) => t.termCode === e.target.value);
    setForm({ ...form, termCode: e.target.value, term: opt?.term ?? '' });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.termCode) { setError('Term is required.'); return; }
    setLoading(true);
    setError('');
    const payload = {
      termCode: form.termCode,
      term: form.term,
      submissionOpenAt: form.submissionOpenAt || undefined,
      submissionDeadline: form.submissionDeadline || undefined,
      status: form.status,
    };
    try {
      let res;
      if (isEdit) {
        res = await updateSchedulingCycle(cycle._id, payload);
      } else {
        res = await createSchedulingCycle(cohortId, payload);
      }
      onSaved(res.data.cycle);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to save cycle.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{isEdit ? 'Edit Scheduling Cycle' : 'Create Scheduling Cycle'}</h2>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label>Term *</label>
            <select value={form.termCode} onChange={handleTermChange}>
              <option value="">-- Select Term --</option>
              {termOptions.map((t) => (
                <option key={t.termCode} value={t.termCode}>
                  {t.term} ({t.termCode})
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Opens At (optional)</label>
            <input
              type="datetime-local"
              value={form.submissionOpenAt}
              onChange={(e) => setForm({ ...form, submissionOpenAt: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>Submission Deadline (optional)</label>
            <input
              type="datetime-local"
              value={form.submissionDeadline}
              onChange={(e) => setForm({ ...form, submissionDeadline: e.target.value })}
            />
          </div>
          {isEdit && (
            <div className="form-group">
              <label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="draft">Draft</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          )}
          <div className="modal-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            {/* Bottom-left: Delete (edit mode only), with a confirm step */}
            <div>
              {isEdit && (
                confirmDelete ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: 'var(--color-danger)', fontWeight: 600 }}>Delete this cycle and all its data?</span>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      style={{ fontSize: 12, padding: '4px 10px', background: 'var(--color-danger)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
                    >
                      {deleting ? 'Deleting…' : 'Yes, delete'}
                    </button>
                    <button type="button" className="btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setConfirmDelete(false)} disabled={deleting}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    style={{ fontSize: 12, padding: '6px 12px', background: 'transparent', color: 'var(--color-danger)', border: '1px solid var(--color-danger)', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
                  >
                    Delete
                  </button>
                )
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Saving…' : isEdit ? 'Save' : 'Create Cycle'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scheduling Cycles Section
// ---------------------------------------------------------------------------
function cycleBadgeStyle(status) {
  const base = { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
  if (status === 'open') return { ...base, background: 'transparent', color: '#065f46' };
  if (status === 'closed') return { ...base, background: 'transparent', color: '#1a1a1a' };
  if (status === 'archived') return { ...base, background: '#f3f4f6', color: '#6b7280' };
  return { ...base, background: '#fffbeb', color: '#92400e' }; // draft
}

// Returns the effective display status for a cycle.
// Archived flag overrides status. A past submissionDeadline on an open cycle
// is treated as closed (deadline enforcement without mutating stored status).
function cycleDisplayStatus(c) {
  if (c.archived === true || c.status === 'archived') return 'archived';
  if (c.status === 'closed') return 'closed';
  if (c.submissionDeadline && new Date(c.submissionDeadline) < new Date()) return 'closed';
  return c.status;
}

function SchedulingCyclesSection({ cohortId, termOptions, isArchived }) {
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editCycle, setEditCycle] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [reclassifyLoading, setReclassifyLoading] = useState(null); // cycleId
  const [reclassifySummary, setReclassifySummary] = useState({}); // { [cycleId]: summary|error }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getCyclesForCohort(cohortId);
      setCycles(res.data.cycles ?? []);
    } catch {
      setError('Failed to load scheduling cycles.');
    } finally {
      setLoading(false);
    }
  }, [cohortId]);

  useEffect(() => { load(); }, [load]);

  const handleSaved = (cycle) => {
    setShowCreate(false);
    setEditCycle(null);
    setCycles((prev) => {
      const idx = prev.findIndex((c) => c._id === cycle._id);
      if (idx >= 0) { const next = [...prev]; next[idx] = cycle; return next; }
      return [cycle, ...prev];
    });
  };

  const handleDeleted = (cycleId) => {
    setEditCycle(null);
    setCycles((prev) => prev.filter((c) => c._id !== cycleId));
  };

  const doAction = async (fn, cycleId) => {
    setActionLoading(cycleId);
    try {
      const res = await fn(cycleId);
      setCycles((prev) => prev.map((c) => (c._id === cycleId ? res.data.cycle : c)));
    } catch (err) {
      alert(err?.response?.data?.error || 'Action failed.');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReclassifyAll = async (cycleId) => {
    setReclassifyLoading(cycleId);
    setReclassifySummary((prev) => ({ ...prev, [cycleId]: null }));
    try {
      const res = await adminReclassifyCohortCycle(cohortId, cycleId);
      setReclassifySummary((prev) => ({ ...prev, [cycleId]: res.data }));
    } catch (err) {
      setReclassifySummary((prev) => ({
        ...prev,
        [cycleId]: { error: err?.response?.data?.error || 'Reclassification failed.' },
      }));
    } finally {
      setReclassifyLoading(null);
    }
  };

  return (
    <div style={{ marginTop: 20 }}>
      {showCreate && (
        <CycleModal
          cohortId={cohortId}
          termOptions={termOptions}
          onClose={() => setShowCreate(false)}
          onSaved={handleSaved}
        />
      )}
      {editCycle && (
        <CycleModal
          cohortId={cohortId}
          cycle={editCycle}
          termOptions={termOptions}
          onClose={() => setEditCycle(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Scheduling Cycles</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {!isArchived && (
            <button className="btn-primary btn-sm" onClick={() => setShowCreate(true)} style={{ fontSize: 12 }}>
              + New Cycle
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <p className="text-muted" style={{ fontSize: 13 }}>Loading cycles…</p>
      ) : cycles.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13 }}>No scheduling cycles yet. Create one to open a registration window.</p>
      ) : (
        <div className="table-wrap" style={{ fontSize: 13 }}>
          <table>
            <thead>
              <tr>
                <th>Term</th>
                <th>Code</th>
                <th>Opens</th>
                <th>Deadline</th>
                <th>Status</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => {
                const displayStatus = cycleDisplayStatus(c);
                return (
                <tr key={c._id}>
                  <td>{c.term}</td>
                  <td><code style={{ fontSize: 11 }}>{c.termCode}</code></td>
                  <td>{c.submissionOpenAt ? new Date(c.submissionOpenAt).toLocaleDateString() : '—'}</td>
                  <td>{c.submissionDeadline ? new Date(c.submissionDeadline).toLocaleDateString() : '—'}</td>
                  <td><span style={cycleBadgeStyle(displayStatus)}>{displayStatus}</span></td>
                  <td>
                    {c.activeForStudents
                      ? <span style={{ ...cycleBadgeStyle('open'), background: '#dbeafe', color: '#1e40af' }}>Yes</span>
                      : <span className="text-muted">—</span>}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {/* Activate — draft or closed */}
                      {c.status !== 'open' && (
                        <button
                          className="btn-primary btn-sm"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          disabled={actionLoading === c._id}
                          onClick={() => doAction(activateCycle, c._id)}
                        >
                          Activate
                        </button>
                      )}
                      {/* Close — open cycles, including deadline-expired */}
                      {c.status === 'open' && (
                        <button
                          className="btn-secondary btn-sm"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          disabled={actionLoading === c._id}
                          onClick={() => doAction(closeCycle, c._id)}
                        >
                          Close
                        </button>
                      )}
                      {/* Edit (Delete lives inside the edit modal) */}
                      <button
                        className="btn-secondary btn-sm"
                        style={{ padding: '4px 8px', display: 'flex', alignItems: 'center' }}
                        onClick={() => setEditCycle(c)}
                        title="Edit"
                      >
                        <img src="/icon-edit.png" alt="Edit" style={{ width: 12, height: 12, objectFit: 'contain' }} />
                      </button>
                    </div>
                    {reclassifySummary[c._id] && (
                      <div style={{ marginTop: 4, fontSize: 11 }}>
                        {reclassifySummary[c._id].error ? (
                          <span style={{ color: 'var(--color-danger)' }}>{reclassifySummary[c._id].error}</span>
                        ) : (
                          <span style={{ color: '#16a34a' }}>
                            Done: {reclassifySummary[c._id].totalStudents} students, {reclassifySummary[c._id].totalCourses} courses
                            {' '}(req: {reclassifySummary[c._id].required}, pref: {reclassifySummary[c._id].preferred},
                            {' '}n/a: {reclassifySummary[c._id].notApplied}, unc: {reclassifySummary[c._id].unclassified})
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CohortCard
// ---------------------------------------------------------------------------
function CohortCard({ cohort, isSelected, onSelect, onEdit, termOptions, isDragOver, onDragStart, onDragOver, onDragEnd, onDrop }) {
  const isArchived = !!cohort.archivedAt;
  const [draggable, setDraggable] = useState(false);

  return (
    <div
      style={{ marginBottom: 16, position: 'relative' }}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDrop={onDrop}
      onDragEnd={() => { setDraggable(false); onDragEnd(); }}
    >
      {/* Drop-target indicator line */}
      {isDragOver && (
        <div style={{
          position: 'absolute', top: -3, left: 0, right: 0, height: 3,
          background: 'var(--color-primary)', borderRadius: 2, zIndex: 10,
          pointerEvents: 'none',
        }} />
      )}
      {/* Card header */}
      <div
        className="card"
        style={{
          borderLeft: isSelected ? '4px solid var(--color-primary)' : '1px solid var(--color-border)',
          padding: '18px 24px',
          cursor: 'pointer',
          opacity: isArchived ? 0.55 : 1,
          transition: 'border-color 0.15s',
          borderRadius: isSelected ? '8px 8px 0 0' : undefined,
          marginBottom: isSelected ? 0 : undefined,
        }}
        onClick={() => onSelect(cohort._id)}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          {/* Drag handle + name */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: '1 1 160px' }}>
            <div
              title="Drag to reorder"
              style={{ cursor: 'grab', color: 'var(--color-text-muted)', fontSize: 18, lineHeight: 1, paddingTop: 3, userSelect: 'none', flexShrink: 0 }}
              onMouseDown={(e) => { e.stopPropagation(); setDraggable(true); }}
              onMouseUp={() => setDraggable(false)}
              onClick={(e) => e.stopPropagation()}
            >
              ⠿
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{cohort.name}</div>
              {cohort.catalogYear && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>Catalog: {cohort.catalogYear}</div>
              )}
              {isArchived && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>Archived cohort</div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div className="stat-card">
              <div className="stat-value">{cohort.joinedCount}</div>
              <div className="stat-label">Joined</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{cohort.submittedCount}</div>
              <div className="stat-label">Submitted</div>
            </div>
            <div className="stat-card">
              <div style={{ marginTop: 4 }}>
                {!cohort.joinCode
                  ? <span className="badge badge-none" style={{ borderRadius: 6 }}>No Code</span>
                  : cohort.joinCodeEnabled
                  ? <span className="badge badge-active" style={{ background: '#e8f5e9', borderRadius: 6 }}>Active</span>
                  : <span className="badge" style={{ background: 'transparent', color: '#374151', fontWeight: 400, fontStyle: 'italic', borderRadius: 6 }}>Disabled</span>
                }
              </div>
              <div className="stat-label">Join Code</div>
            </div>
            <button
                className="btn-secondary btn-sm"
                style={{ fontSize: 12, padding: '4px 12px', alignSelf: 'center', display: 'flex', alignItems: 'center' }}
                onClick={(e) => { e.stopPropagation(); onEdit(cohort); }}
                title={isArchived ? 'Unarchive…' : 'Edit'}
              >
                {isArchived ? 'Unarchive…' : <img src="/icon-edit.png" alt="Edit" style={{ width: 12, height: 12, objectFit: 'contain' }} />}
              </button>
          </div>
        </div>
      </div>

      {/* Expanded scheduling cycles panel */}
      {isSelected && (
        <div
          className="card"
          style={{
            borderLeft: '4px solid var(--color-primary)',
            borderTop: '1px solid var(--color-border, #e5e7eb)',
            borderRadius: '0 0 8px 8px',
            padding: '16px 24px 20px',
            background: 'var(--color-bg-subtle, #f9fafb)',
            opacity: isArchived ? 0.7 : 1,
          }}
        >
          <SchedulingCyclesSection
            cohortId={cohort._id}
            termOptions={termOptions}
            isArchived={isArchived}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function AdminCohorts() {
  const [cohorts, setCohorts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editCohort, setEditCohort] = useState(null);
  const [expandedCohorts, setExpandedCohorts] = useState(new Set());
  const [termOptions, setTermOptions] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const dragIndex = useRef(null);
  const [dragOverId, setDragOverId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cohortsRes, termsRes] = await Promise.all([getCohorts(showArchived), getTermOptions()]);
      setCohorts(cohortsRes.data);
      setTermOptions(termsRes.data.terms ?? []);
    } catch {
      setError('Failed to load cohorts.');
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  const handleCreated = (newCohort) => {
    setShowModal(false);
    setCohorts((prev) => [{ ...newCohort, joinedCount: 0, submittedCount: 0 }, ...prev]);
  };

  const handleUpdated = (updated) => {
    setEditCohort(null);
    setCohorts((prev) => prev.map((c) => (c._id === updated._id ? { ...c, ...updated } : c)));
  };

  const handleArchived = (archived) => {
    setEditCohort(null);
    if (showArchived) {
      setCohorts((prev) => prev.map((c) => (c._id === archived._id ? { ...c, ...archived } : c)));
    } else {
      setCohorts((prev) => prev.filter((c) => c._id !== archived._id));
    }
    setExpandedCohorts((prev) => { const next = new Set(prev); next.delete(archived._id); return next; });
  };

  const handleUnarchived = () => {
    setEditCohort(null);
    load();
  };

  const toggleExpand = (id) => setExpandedCohorts((prev) => {
    const next = new Set(prev);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    return next;
  });

  const handleDragStart = (index) => { dragIndex.current = index; };
  const handleDragOver = (id) => { if (dragOverId !== id) setDragOverId(id); };
  const handleDragEnd = () => { dragIndex.current = null; setDragOverId(null); };
  const handleDrop = (dropIndex) => {
    const from = dragIndex.current;
    if (from === null || from === dropIndex) { handleDragEnd(); return; }
    const next = [...cohorts];
    const [moved] = next.splice(from, 1);
    next.splice(dropIndex, 0, moved);
    setCohorts(next);
    // Persist the new order so it survives reload (best-effort).
    reorderCohorts(next.map((c) => c._id)).catch(() => setError('Failed to save cohort order.'));
    handleDragEnd();
  };

  return (
    <>
      {showModal && (
        <CreateCohortModal onClose={() => setShowModal(false)} onCreated={handleCreated} />
      )}
      {editCohort && (
        <EditCohortModal
          cohort={editCohort}
          onClose={() => setEditCohort(null)}
          onUpdated={handleUpdated}
          onArchived={handleArchived}
          onUnarchived={handleUnarchived}
        />
      )}

      <div className="page-header">
        <h1>Cohorts</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--color-text-muted)' }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            + Create Cohort
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="empty-state"><p>Loading cohorts…</p></div>
      ) : cohorts.length === 0 ? (
        <div className="empty-state">
          <h3>No cohorts yet</h3>
          <p>Create your first cohort to get started.</p>
        </div>
      ) : (
        <div>
          {cohorts.map((c, i) => (
            <CohortCard
              key={c._id}
              cohort={c}
              isSelected={expandedCohorts.has(c._id)}
              onSelect={toggleExpand}
              onEdit={setEditCohort}
              termOptions={termOptions}
              isDragOver={dragOverId === c._id}
              onDragStart={() => handleDragStart(i)}
              onDragOver={() => handleDragOver(c._id)}
              onDragEnd={handleDragEnd}
              onDrop={() => handleDrop(i)}
            />
          ))}
        </div>
      )}
    </>
  );
}
