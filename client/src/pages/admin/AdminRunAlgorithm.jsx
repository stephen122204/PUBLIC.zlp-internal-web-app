export default function AdminRunAlgorithm() {
  return (
    <>
      <div className="page-header">
        <h1>Run Algorithm</h1>
      </div>
      <div className="card" style={{ textAlign: 'center', padding: '60px 40px' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>&#9654;&#65039;</div>
        <h2 style={{ marginBottom: 12 }}>ZLP Scheduling Algorithm</h2>
        <p
          style={{
            color: 'var(--color-text-muted)',
            maxWidth: 440,
            margin: '0 auto 28px',
            lineHeight: 1.6,
          }}
        >
          The scheduling algorithm will analyze student submissions and generate
          optimized ZLP window assignments. This feature is coming soon.
        </p>
        <button className="btn-primary" disabled style={{ padding: '12px 32px', fontSize: 15 }}>
          Run Algorithm
        </button>
        <div className="alert alert-warn" style={{ maxWidth: 360, margin: '20px auto 0' }}>
          Scheduler implementation pending.
        </div>
      </div>
    </>
  );
}
