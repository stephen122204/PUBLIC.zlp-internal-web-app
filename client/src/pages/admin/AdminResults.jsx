export default function AdminResults() {
  return (
    <>
      <div className="page-header">
        <h1>Results</h1>
      </div>
      <div className="empty-state">
        <div style={{ fontSize: 48 }}>&#128202;</div>
        <h3>No Results Yet</h3>
        <p>Run the algorithm to view ranked ZLP windows.</p>
      </div>
    </>
  );
}
