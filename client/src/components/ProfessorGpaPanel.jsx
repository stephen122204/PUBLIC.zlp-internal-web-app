// Professor GPA panel — historical grade-distribution data for the unique
// professors teaching a course this term. Two columns: last-semester average
// (across all that professor's sections that term) and overall average (all
// scraped history). Data comes from gradeStats on the /courses/sections API.
// Always renders when there's at least one instructor; grade history is shown
// per-professor when available ("n/a" otherwise). The syllabus link is
// independent of grade-history match — grade reports lag a term's end, but a
// syllabus can be uploaded (and found) for the current term or an older one.

// Color a GPA value: green (high) → amber (mid) → red (low).
function gpaColor(gpa) {
  if (gpa == null) return 'inherit';
  if (gpa >= 3.5) return '#15803d';
  if (gpa >= 3.0) return '#16a34a';
  if (gpa >= 2.5) return '#d97706';
  return '#dc2626';
}

function SyllabusLink({ url, termLabel }) {
  if (!url) return null;
  return (
    <>
      {' '}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontSize: 11, color: 'var(--color-primary, #2563eb)', textDecoration: 'underline', whiteSpace: 'nowrap', fontStyle: 'normal' }}
        title={termLabel ? `Syllabus from ${termLabel} (opens PDF)` : 'Opens syllabus PDF'}
      >
        syllabus ↗
      </a>
    </>
  );
}

export default function ProfessorGpaPanel({ gradeStats, compact = false }) {
  const instructors = gradeStats?.instructors ?? [];
  if (instructors.length === 0) return null;

  const years = gradeStats?.scope?.years;
  const yearLabel = years?.length ? ` ${years[0]}–${years[years.length - 1]}` : '';
  const pad = compact ? '8px 12px' : '12px 20px';

  return (
    <div style={{ padding: pad, borderBottom: '1px solid var(--color-border)', background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Professor GPA for this course (historical)</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}> <i>Source: TAMU grade reports{yearLabel}</i></div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)', fontSize: 11 }}>
            <th style={{ padding: '2px 8px 4px 0', fontWeight: 600 }}>Professor</th>
            <th style={{ padding: '2px 8px 4px', fontWeight: 600 }}>Last Sem Avg</th>
            <th style={{ padding: '2px 8px 4px', fontWeight: 600 }}>Overall Avg</th>
          </tr>
        </thead>
        <tbody>
          {instructors.map((it) => (
            <tr key={it.instructor} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>{it.instructor}</td>
              {it.matched ? (
                <>
                  <td style={{ padding: '4px 8px' }}>
                    {it.lastTaught ? (
                      <>
                        <strong style={{ color: gpaColor(it.lastTaught.gpa) }}>{it.lastTaught.gpa.toFixed(3)}</strong>
                        <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}> ({it.lastTaught.term}, {it.lastTaught.students} stu)</span>
                        <SyllabusLink url={it.lastTaughtSyllabusUrl} termLabel={it.syllabusTermLabel} />
                      </>
                    ) : <span style={{ color: 'var(--color-text-muted)' }}>n/a</span>}
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <strong style={{ color: gpaColor(it.overallGpa) }}>{it.overallGpa.toFixed(3)}</strong>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}> ({it.overallStudents} stu)</span>
                  </td>
                </>
              ) : (
                <td colSpan={2} style={{ padding: '4px 8px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                  n/a — no grade history for this course
                  <SyllabusLink url={it.lastTaughtSyllabusUrl} termLabel={it.syllabusTermLabel} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
