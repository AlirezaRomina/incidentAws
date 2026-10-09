import { navigate } from '../../router';

export function NotFound() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <div className="empty" style={{ maxWidth: 420 }}>
        <h2 style={{ marginTop: 0 }}>Incident not found</h2>
        <p>This link points to an incident that doesn't exist.</p>
        <button className="btn btn-primary" onClick={() => navigate('#/')}>
          Back to the incident board
        </button>
      </div>
    </div>
  );
}
