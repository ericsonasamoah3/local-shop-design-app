import { useState } from 'react';

const SPACE_TYPES = [
  { value: 'bed', label: 'Bed' },
  { value: 'bedside_table', label: 'Bedside table (coming soon)' },
  { value: 'bedroom_corner', label: 'Bedroom corner (coming soon)' },
];

const BUDGETS = [
  { value: 'budget', label: 'Budget' },
  { value: 'mid', label: 'Mid-range' },
  { value: 'premium', label: 'Premium' },
  { value: 'any', label: 'Show me all price ranges' },
];

const STYLES = [
  { value: 'any', label: 'No preference' },
  { value: 'modern', label: 'Modern' },
  { value: 'rustic', label: 'Rustic' },
  { value: 'minimalist', label: 'Minimalist' },
];

export default function IntakeForm({ onSubmit, submitting }) {
  const [spaceType, setSpaceType] = useState('bed');
  const [budget, setBudget] = useState('mid');
  const [style, setStyle] = useState('any');
  const [occasion, setOccasion] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit({ spaceType, budget, style, occasion });
  }

  return (
    <form className="intake-card" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="space_type">What is this space?</label>
        <select id="space_type" value={spaceType} onChange={(e) => setSpaceType(e.target.value)}>
          {SPACE_TYPES.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="budget">Budget</label>
        <select id="budget" value={budget} onChange={(e) => setBudget(e.target.value)}>
          {BUDGETS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="style">Style (optional)</label>
        <select id="style" value={style} onChange={(e) => setStyle(e.target.value)}>
          {STYLES.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="occasion">Anything else? (optional)</label>
        <input
          id="occasion"
          type="text"
          value={occasion}
          onChange={(e) => setOccasion(e.target.value)}
          placeholder="e.g. just moved in"
        />
      </div>

      <button className="btn" type="submit" disabled={submitting}>
        {submitting ? 'Finding suggestions…' : 'Get suggestions'}
      </button>
    </form>
  );
}
