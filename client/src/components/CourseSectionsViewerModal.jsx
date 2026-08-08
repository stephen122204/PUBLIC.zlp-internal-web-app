import { useState, useEffect } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { adminGetCourseSections } from '../api';
import ProfessorGpaPanel from './ProfessorGpaPanel';

function formatMeetings(meetings) {
  if (!meetings?.length) return null;
  return meetings.map((m) => {
    const time = m.startTime && m.endTime ? ` ${m.startTime}–${m.endTime}` : '';
    const loc  = m.location ? ` · ${m.location}` : '';
    return `${m.days ?? '?'}${time}${loc}`;
  }).join(' | ');
}

// ---------------------------------------------------------------------------
// CourseSectionsViewerModal
// Read-only viewer for a course's sections (CRN / Section / Instructor /
// Schedule) plus historical professor GPA. Opened from the algorithm results so
// an admin can inspect a conflicting course's section times in place — no
// selection, no saving. Mirrors the admin "Manage" section modal, view-only.
// ---------------------------------------------------------------------------
export default function CourseSectionsViewerModal({ code, title = '', termCode, highlightSections = [], isPreferred = false, onClose }) {
  useEscapeKey(onClose);
  // Section ids to highlight (a restricted student's chosen sections that clash
  // with the ZLP window). Matched against section number or CRN.
  const highlightSet = new Set((highlightSections ?? []).map((s) => String(s)));
  const [available, setAvailable]   = useState([]);
  const [gradeStats, setGradeStats] = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');

  useEffect(() => {
    if (!code) return;
    if (!termCode) { setLoading(false); setError('No term code available for this run.'); return; }
    const [subj, num] = code.split(' ');
    setLoading(true);
    setError('');
    adminGetCourseSections(subj, num, termCode)
      .then((res) => {
        setAvailable(res.data.sections ?? []);
        setGradeStats(res.data.gradeStats ?? null);
      })
      .catch((err) => setError(err?.response?.data?.error ?? 'Failed to load sections.'))
      .finally(() => setLoading(false));
  }, [code, termCode]);

  // A preferred course blocked on every available section is a full block, not a
  // section-choice narrowing — highlighting every row conveys nothing, so drop it.
  // Partial blocks (only some sections clash) stay highlighted.
  const allSectionsClash = available.length > 0 &&
    available.every((sec) => highlightSet.has(String(sec.section)) || highlightSet.has(String(sec.crn)));
  const suppressHighlight = isPreferred && allSectionsClash;

  return (
    <div className="modal-overlay" style={{ zIndex: 10001 }} onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 680, width: '96vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Sections &mdash; <span style={{ fontFamily: 'monospace' }}>{code}</span></h3>
            {title && <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 2 }}>{title}</div>}
          </div>
          <button className="btn-secondary" style={{ fontSize: 12 }} onClick={onClose}>&#10005;</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {loading && <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Loading sections&hellip;</p>}
          {error   && <div className="alert alert-error">{error}</div>}
          {!loading && !error && available.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              No section data found for <strong>{code}</strong> in term <strong>{termCode}</strong>.
            </p>
          )}
          {!loading && available.length > 0 && (
            <ProfessorGpaPanel gradeStats={gradeStats} compact />
          )}
          {!loading && available.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--color-surface)', borderBottom: '2px solid var(--color-border)' }}>
                  <th style={{ padding: '5px 8px', textAlign: 'left' }}>CRN</th>
                  <th style={{ padding: '5px 8px', textAlign: 'left' }}>Section</th>
                  <th style={{ padding: '5px 8px', textAlign: 'left' }}>Instructor</th>
                  <th style={{ padding: '5px 8px', textAlign: 'left' }}>Schedule</th>
                </tr>
              </thead>
              <tbody>
                {available.map((sec) => {
                  const instructorLabel = (sec.instructors ?? []).map((i) => i.name ?? i).filter(Boolean).join(', ') || '—';
                  const schedule = formatMeetings(sec.meetings) ?? '—';
                  const highlighted = !suppressHighlight && (highlightSet.has(String(sec.section)) || highlightSet.has(String(sec.crn)));
                  return (
                    <tr
                      key={String(sec.crn)}
                      title={highlighted ? 'Chosen section that clashes with this ZLP window' : undefined}
                      style={{
                        borderBottom: '1px solid var(--color-border)',
                        background: highlighted ? '#fef9c3' : undefined,
                        boxShadow: highlighted ? 'inset 3px 0 0 #eab308' : undefined,
                      }}
                    >
                      <td style={{ padding: '5px 8px', fontFamily: 'monospace' }}>{sec.crn}</td>
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
      </div>
    </div>
  );
}
