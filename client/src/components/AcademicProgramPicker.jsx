/**
 * AcademicProgramPicker
 *
 * A searchable modal picker for TAMU degree programs (majors or minors).
 *
 * Props:
 *   type        'major' | 'minor'
 *   value       string (single) | string[] (multiple)
 *   onChange    (newValue) => void
 *   multiple    boolean
 *   placeholder string
 *   onClose     () => void  (call to dismiss)
 *   excludeIds  string[]  — programs already chosen elsewhere; hidden from the list
 *                          so the same program can't be picked twice. The value
 *                          being edited stays visible even if it's in the list.
 */
import { useEffect, useState } from 'react';
import { getAcademicMajors, getAcademicMinors } from '../api';
import { useEscapeKey } from '../hooks/useEscapeKey';

export default function AcademicProgramPicker({ type, value, onChange, multiple, placeholder, onClose, onClear, catalogYear, excludeIds = [] }) {
  useEscapeKey(onClose);
  const [programs, setPrograms]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [query, setQuery]           = useState('');

  // Normalize value to an array of selected IDs
  const selected = multiple
    ? (Array.isArray(value) ? value : (value ? [value] : []))
    : (value ? [value] : []);

  useEffect(() => {
    const fetcher = type === 'minor' ? getAcademicMinors : getAcademicMajors;
    fetcher(catalogYear ? { catalog: catalogYear } : undefined)
      .then((res) => setPrograms(res.data.programs ?? []))
      .catch(() => setError('Failed to load program list.'))
      .finally(() => setLoading(false));
  }, [type, catalogYear]);

  // Hide programs taken by another slot, but never the one being edited.
  const hidden = new Set(excludeIds.filter((id) => !selected.includes(id)));
  const available = hidden.size ? programs.filter((p) => !hidden.has(p.id)) : programs;

  // Filter by query
  const filtered = query.trim()
    ? available.filter((p) =>
        p.title.toLowerCase().includes(query.toLowerCase()) ||
        (p.college ?? '').toLowerCase().includes(query.toLowerCase())
      )
    : available;

  function handleToggle(id) {
    if (multiple) {
      const next = selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id];
      onChange(next, programs.filter((p) => next.includes(p.id)));
    } else {
      const newVal = id === selected[0] ? null : id;
      onChange(newVal, newVal ? programs.find((p) => p.id === newVal) ?? null : null);
      // Auto-close after selecting a single item
      if (newVal) onClose();
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        <h2 style={{ marginBottom: 10 }}>
          {multiple ? 'Select' : 'Select'} {type === 'minor' ? 'Minor' : 'Major'}
          {multiple ? 's' : ''}
        </h2>

        {/* Search */}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder ?? `Search ${type}s…`}
          style={{ marginBottom: 10 }}
        />

        {/* List */}
        {loading && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading…</p>}
        {error   && <div className="alert alert-error" style={{ flexShrink: 0 }}>{error}</div>}

        {!loading && !error && (
          <div style={{ overflowY: 'auto', flex: 1, border: '1px solid var(--color-border)', borderRadius: 6 }}>
            {filtered.length === 0 && (
              <p style={{ padding: '12px 16px', fontSize: 13, color: 'var(--color-text-muted)' }}>
                No {type}s match your search.
              </p>
            )}
            {filtered.map((p) => {
              const isSelected = selected.includes(p.id);
              return (
                <label
                  key={p.id}
                  style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    padding: '8px 12px', cursor: 'pointer',
                    background: isSelected ? 'var(--color-bg-hover, #f0f4ff)' : 'transparent',
                    borderBottom: '1px solid var(--color-border)',
                  }}
                >
                  <input
                    type={multiple ? 'checkbox' : 'radio'}
                    name="program-picker"
                    checked={isSelected}
                    onChange={() => handleToggle(p.id)}
                    style={{ marginTop: 3, flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>
                      {p.title}

                    </div>
                    {p.college && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                        {p.college}{p.catalog ? ` · ${p.catalog}` : ''}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {/* Footer */}
        {multiple && selected.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8, flexShrink: 0 }}>
            {selected.length} selected
          </div>
        )}
        <div className="modal-actions" style={{ flexShrink: 0, marginTop: 10 }}>
          {multiple && (
            <button type="button" className="btn-secondary" onClick={onClose}>Done</button>
          )}
          {onClear && selected.length > 0 && (
            <button type="button" className="btn-secondary" onClick={onClear}>Clear</button>
          )}
          {multiple && selected.length > 0 && (
            <button type="button" className="btn-secondary" onClick={() => onChange([], [])}>Clear all</button>
          )}
        </div>
      </div>
    </div>
  );
}
