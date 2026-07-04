export default function AdminExport() {
  return (
    <>
      <div className="page-header">
        <h1>Export</h1>
      </div>
      <div className="empty-state">
        <div style={{ fontSize: 48 }}>&#128196;</div>
        <h3>No Exports Available</h3>
        <p>Exports will be available after an algorithm run.</p>
      </div>
    </>
  );
}
