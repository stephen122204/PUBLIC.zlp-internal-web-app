/**
 * AcademicProfileEditor
 *
 * Inline editor for a student's academic profile (primary major, additional
 * majors, minors). Catalog year is set at the cohort level — shown read-only.
 *
 * Props:
 *   profile             current profile object (from API) or null
 *   cohortCatalogYear   string | null  — from the cohort, displayed read-only
 *   onSave              async (data) => void  — data: { primaryMajorId, primaryTrackId, additionalMajorIds, minorIds }
 *   allowMultipleMajors boolean  (default false) — when true, additional majors can be added/edited;
 *                               admin-controlled via secondaryProgramEnabled on the profile
 *   allowMinors         boolean  (default true)
 *   saving              boolean  — shows spinner on Save button while parent is saving
 */
import { useState, useEffect } from 'react';
import AcademicProgramPicker from './AcademicProgramPicker';
import { getDegreeGraph } from '../api';

/**
 * Convert a semester-term string ("Fall 2023", "Spring 2024", "Summer 2024")
 * to the TAMU catalog year format used in the data ("2023-2024").
 */
function termToCatalogYear(term) {
  if (!term) return null;
  const [semester, yearStr] = term.split(' ');
  const year = parseInt(yearStr, 10);
  if (isNaN(year)) return null;
  if (semester === 'Fall') return `${year}-${year + 1}`;
  return `${year - 1}-${year}`; // Spring / Summer
}

export default function AcademicProfileEditor({
  profile,
  cohortCatalogYear = null,
  effectiveCatalogYear = null, // override for per-student (admin only)
  catalogYearSource = 'cohort_default', // 'cohort_default' | 'student_override'
  onSave,
  allowMultipleMajors = false,
  allowMinors = true,
  saving = false,
}) {
  // Convert whichever catalog year is in effect to TAMU's "YYYY-YYYY" format
  const activeTerm = effectiveCatalogYear ?? cohortCatalogYear;
  const catalogYearParam = termToCatalogYear(activeTerm);
  const [primaryMajorId,     setPrimaryMajorId]     = useState(profile?.primaryMajor?.programId ?? null);
  const [primaryMajorTitle,  setPrimaryMajorTitle]  = useState(profile?.primaryMajor?.title ?? null);
  const [primaryTrackId,     setPrimaryTrackId]     = useState(profile?.primaryMajor?.selectedTrackId ?? null);
  const [availableTracks,    setAvailableTracks]    = useState([]);
  const [additionalMajorIds, setAdditionalMajorIds] = useState(
    (profile?.additionalMajors ?? []).map((m) => m.programId)
  );
  const [minorIds, setMinorIds] = useState(
    (profile?.minors ?? []).map((m) => m.programId)
  );

  // Load the selectable tracks for the primary major (only single-page multi-track
  // majors like BMEN expose availableTracks). Refetched whenever the major changes.
  useEffect(() => {
    let cancelled = false;
    if (!primaryMajorId) { setAvailableTracks([]); return; }
    getDegreeGraph(primaryMajorId)
      .then((res) => { if (!cancelled) setAvailableTracks(res?.data?.graph?.availableTracks ?? []); })
      .catch(() => { if (!cancelled) setAvailableTracks([]); });
    return () => { cancelled = true; };
  }, [primaryMajorId]);

  // Unified save: always carries the current selection; callers override changed fields.
  function emitSave(overrides = {}) {
    onSave({ primaryMajorId, primaryTrackId, additionalMajorIds, minorIds, ...overrides });
  }
  // Title lookup maps so we display human-readable names instead of raw IDs
  const [titleMap, setTitleMap] = useState(() => {
    const map = {};
    for (const m of profile?.additionalMajors ?? []) map[m.programId] = m.title;
    for (const m of profile?.minors ?? []) map[m.programId] = m.title;
    return map;
  });

  // picker: null | { mode: 'primary' | 'additional-add' | 'additional-edit' | 'minor-add' | 'minor-edit', index?: number }
  const [picker, setPicker] = useState(null);

  function handlePickerChange(newValue, programOrPrograms) {
    const title = Array.isArray(programOrPrograms)
      ? programOrPrograms[0]?.title ?? null
      : programOrPrograms?.title ?? null;
    const id = Array.isArray(newValue) ? newValue[0] ?? null : newValue ?? null;

    if (!picker) return;
    const { mode, index } = picker;

    if (mode === 'primary') {
      setPrimaryMajorId(id);
      setPrimaryMajorTitle(title);
      // Changing the major invalidates any prior track choice.
      setPrimaryTrackId(null);
      setPicker(null);
      emitSave({ primaryMajorId: id ?? null, primaryTrackId: null });
    } else if (mode === 'additional-add') {
      if (id) {
        const newIds = [...additionalMajorIds, id];
        setAdditionalMajorIds(newIds);
        setTitleMap((prev) => ({ ...prev, [id]: title ?? id }));
        setPicker(null);
        emitSave({ additionalMajorIds: newIds });
      }
    } else if (mode === 'additional-edit') {
      if (id) {
        const newIds = additionalMajorIds.map((x, i) => (i === index ? id : x));
        setAdditionalMajorIds(newIds);
        setTitleMap((prev) => ({ ...prev, [id]: title ?? id }));
        setPicker(null);
        emitSave({ additionalMajorIds: newIds });
      }
    } else if (mode === 'minor-add') {
      if (id) {
        const newIds = [...minorIds, id];
        setMinorIds(newIds);
        setTitleMap((prev) => ({ ...prev, [id]: title ?? id }));
        setPicker(null);
        emitSave({ minorIds: newIds });
      }
    } else if (mode === 'minor-edit') {
      if (id) {
        const newIds = minorIds.map((x, i) => (i === index ? id : x));
        setMinorIds(newIds);
        setTitleMap((prev) => ({ ...prev, [id]: title ?? id }));
        setPicker(null);
        emitSave({ minorIds: newIds });
      }
    }
  }

  const majorLabel = primaryMajorTitle ?? primaryMajorId ?? null;

  // Shared row style: [Title] [Edit] [+ Add (optional)]
  function ItemRow({ label, onEdit, onAdd }) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 14 }}>{label}</span>
        <button type="button" className="btn-secondary btn-sm" onClick={onEdit} title="Edit" style={{ display: 'flex', alignItems: 'center' }}>
          <img src="/icon-edit.png" alt="Edit" style={{ width: 12, height: 12, objectFit: 'contain' }} />
        </button>
        {onAdd && (
          <button type="button" className="btn-secondary btn-sm" onClick={onAdd} title="Add" style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>+</button>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Catalog Year — read-only */}
      {(cohortCatalogYear || effectiveCatalogYear) && (() => {
        const displayTerm = effectiveCatalogYear ?? cohortCatalogYear;
        const displayYear = termToCatalogYear(displayTerm) ?? displayTerm;
        const isOverride = catalogYearSource === 'student_override';
        return (
          <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--color-text-muted)' }}>
            <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>Catalog Year: </span>
            {displayYear}
            <span style={{
              marginLeft: 6,
              fontSize: 11,
              color: isOverride ? 'var(--color-primary)' : undefined,
            }}>
              ({isOverride ? 'custom override' : 'set by cohort'})
            </span>
          </div>
        );
      })()}

      {/* Primary Major */}
      <div className="form-group" style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Primary Major</label>
        {majorLabel ? (
          <ItemRow
            label={majorLabel}
            onEdit={() => setPicker({ mode: 'primary' })}
          />
        ) : (
          <button type="button" className="btn-secondary btn-sm" style={{ width: 'fit-content', fontSize: 16, fontWeight: 700, lineHeight: 1 }} onClick={() => setPicker({ mode: 'primary' })} title="Add Major">
            +
          </button>
        )}

        {/* Track selector — only for single-page multi-track majors (e.g. BMEN) */}
        {primaryMajorId && availableTracks.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
              Track
              {!primaryTrackId && (
                <span style={{ fontWeight: 400, color: 'var(--color-primary)', marginLeft: 6 }}>
                  — select your track
                </span>
              )}
            </label>
            <select
              className="input"
              style={{ maxWidth: 360 }}
              value={primaryTrackId ?? ''}
              onChange={(e) => {
                const tid = e.target.value || null;
                setPrimaryTrackId(tid);
                emitSave({ primaryTrackId: tid });
              }}
            >
              <option value="">— Select a track —</option>
              {availableTracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Additional Major(s) / Degree(s) */}
      <div className="form-group" style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
          Additional Major(s) / Degree(s)
          {!allowMultipleMajors && (
            <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-text-muted)', marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <img src="/icon-lock.png" alt="" style={{ width: 14, height: 14, objectFit: 'contain', opacity: 0.5 }} />
              Locked
            </span>
          )}
        </label>
        {allowMultipleMajors ? (
          additionalMajorIds.length > 0
            ? additionalMajorIds.map((id, i) => (
                <ItemRow
                  key={id}
                  label={titleMap[id] ?? id}
                  onEdit={() => setPicker({ mode: 'additional-edit', index: i })}
                  onAdd={i === additionalMajorIds.length - 1 ? () => setPicker({ mode: 'additional-add' }) : undefined}
                />
              ))
            : (
              <button type="button" className="btn-secondary btn-sm" style={{ width: 'fit-content', fontSize: 16, fontWeight: 700, lineHeight: 1 }} onClick={() => setPicker({ mode: 'additional-add' })} title="Add Major">
                +
              </button>
            )
        ) : (
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
            Secondary program enrollment must be enabled by your program director before additional majors can be added.
          </div>
        )}
      </div>

      {/* Minor(s) */}
      {allowMinors && (
        <div className="form-group" style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Minor(s)</label>
          {minorIds.length > 0
            ? minorIds.map((id, i) => (
                <ItemRow
                  key={id}
                  label={titleMap[id] ?? id}
                  onEdit={() => setPicker({ mode: 'minor-edit', index: i })}
                  onAdd={i === minorIds.length - 1 ? () => setPicker({ mode: 'minor-add' }) : undefined}
                />
              ))
            : (
              <button type="button" className="btn-secondary btn-sm" style={{ width: 'fit-content', fontSize: 16, fontWeight: 700, lineHeight: 1 }} onClick={() => setPicker({ mode: 'minor-add' })} title="Add Minor">
                +
              </button>
            )
          }
        </div>
      )}

      {/* Program picker modal */}
      {picker && (
        <AcademicProgramPicker
          type={picker.mode === 'minor-add' || picker.mode === 'minor-edit' ? 'minor' : 'major'}
          value={
            picker.mode === 'primary' ? primaryMajorId :
            picker.mode === 'additional-edit' ? additionalMajorIds[picker.index] :
            picker.mode === 'minor-edit' ? minorIds[picker.index] :
            null
          }
          multiple={false}
          onChange={handlePickerChange}
          onClose={() => setPicker(null)}
          catalogYear={catalogYearParam}
          onClear={
            picker.mode === 'primary'
              ? () => { setPrimaryMajorId(null); setPrimaryMajorTitle(null); setPrimaryTrackId(null); setPicker(null); emitSave({ primaryMajorId: null, primaryTrackId: null }); }
              : picker.mode === 'additional-edit'
              ? () => { const newIds = additionalMajorIds.filter((_, j) => j !== picker.index); setAdditionalMajorIds(newIds); setPicker(null); emitSave({ additionalMajorIds: newIds }); }
              : picker.mode === 'minor-edit'
              ? () => { const newIds = minorIds.filter((_, j) => j !== picker.index); setMinorIds(newIds); setPicker(null); emitSave({ minorIds: newIds }); }
              : null
          }
        />
      )}
    </>
  );
}
