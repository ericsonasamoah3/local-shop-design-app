import { useState } from 'react';
import { geocode } from '../api/client';

// Where the user is, so suggestions can be ranked by distance and the map can
// show how far each shop is. Optional — suggestions work without it.
//
// The browser's location prompt only exists on secure pages (HTTPS, or
// localhost), which is why the app sits behind API Gateway in AWS. A typed
// postcode or town is always offered as well, for people who decline the
// prompt or whose browser cannot answer it.

const GEOCODE_ERRORS = {
  location_not_found: "We couldn't find that place. Try a full postcode, like SG18 8AA.",
  rate_limited: 'Too many lookups for now. Try again in a little while.',
  query_too_long: 'That is a bit long. Try just a postcode or town.',
};

const COVERAGE_NOTES = {
  gathering: 'Finding shops near you. This can take a few minutes the first time.',
  slow: "Still finding shops near you. It's taking longer than usual, so check back soon.",
  none_found: "We looked, but found no shops near you whose products we can read online.",
  busy: "We can't search a new area right now. Try again later.",
  failed: "Something went wrong finding shops near you. Try again later.",
};

export default function LocationPicker({ location, onChange, coverage }) {
  const [status, setStatus] = useState('idle'); // idle | locating | looking_up
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  const canUseDevice =
    typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator;

  function useMyLocation() {
    setError(null);
    setStatus('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setStatus('idle');
        onChange({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          label: 'Your current location',
        });
      },
      (err) => {
        setStatus('idle');
        setError(
          err.code === err.PERMISSION_DENIED
            ? 'Location access is blocked. Type your postcode or town instead.'
            : "Couldn't get your location. Type your postcode or town instead."
        );
      },
      // Shop-level accuracy is plenty; a cached fix from the last 10 minutes
      // is fine and answers instantly.
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  }

  async function lookUp() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setError(null);
    setStatus('looking_up');
    try {
      const result = await geocode(trimmed);
      onChange({ lat: result.lat, lon: result.lon, label: trimmed.toUpperCase() });
      setQuery('');
    } catch (err) {
      setError(GEOCODE_ERRORS[err.message] || 'Postcode lookup is unavailable right now. Try again shortly.');
    } finally {
      setStatus('idle');
    }
  }

  if (location) {
    return (
      <div className="field location-picker">
        <p className="location-picker__label">Shopping near</p>
        <div className="location-picker__current">
          <span className="location-picker__place">{location.label}</span>
          <button type="button" className="link-btn" onClick={() => onChange(null)}>
            Change
          </button>
        </div>
        {coverage && coverage.status === 'covered' && (
          <p className="location-picker__hint">
            {coverage.shops_nearby} shop{coverage.shops_nearby === 1 ? '' : 's'} within 15 miles.
          </p>
        )}
        {coverage && COVERAGE_NOTES[coverage.status] && (
          <p className={`location-picker__hint${coverage.status === 'gathering' ? ' is-working' : ''}`} role="status">
            {COVERAGE_NOTES[coverage.status]}
          </p>
        )}
      </div>
    );
  }

  const busy = status !== 'idle';

  return (
    <div className="field location-picker">
      <label htmlFor="location_query">Where are you? (optional)</label>
      <p className="location-picker__hint">So we can show the nearest shops first.</p>

      {canUseDevice && (
        <button type="button" className="btn btn--secondary" onClick={useMyLocation} disabled={busy}>
          {status === 'locating' ? 'Finding you…' : 'Use my location'}
        </button>
      )}

      <div className="location-picker__row">
        <input
          id="location_query"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Inside the intake <form>, so Enter must not submit the whole thing.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              lookUp();
            }
          }}
          placeholder={canUseDevice ? 'or type a postcode or town' : 'Postcode or town'}
          autoComplete="postal-code"
          disabled={busy}
        />
        <button type="button" className="btn btn--secondary" onClick={lookUp} disabled={busy || !query.trim()}>
          {status === 'looking_up' ? 'Finding…' : 'Find'}
        </button>
      </div>

      {error && <p className="location-picker__error" role="alert">{error}</p>}
    </div>
  );
}
