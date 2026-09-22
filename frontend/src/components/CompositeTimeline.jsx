// The exploded view: every state of the room, left to right, starting from the
// original photo. Clicking a frame makes it the base for the next composite,
// so the user can branch off any earlier version rather than only ever
// building on the newest one.

function Frame({ layer, index, isActive, isPending, onSelect }) {
  return (
    <li
      className={[
        'timeline__item',
        isActive ? 'timeline__item--active' : '',
        isPending ? 'timeline__item--pending' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--i': index }}
    >
      <button
        type="button"
        className="timeline__frame"
        onClick={() => onSelect(layer.id)}
        aria-pressed={isActive}
        aria-label={
          isActive ? `${layer.label} — currently building on this` : `Build on ${layer.label}`
        }
      >
        <span className="timeline__step">{index === 0 ? 'Original' : index}</span>
        {isPending ? (
          <span className="timeline__placeholder" aria-hidden="true" />
        ) : (
          <img src={layer.url} alt="" className="timeline__thumb" />
        )}
        <span className="timeline__label">{layer.label}</span>
      </button>
    </li>
  );
}

export default function CompositeTimeline({ layers, activeLayerId, pending, onSelect }) {
  // One frame is not a timeline.
  if (layers.length < 2 && !pending) return null;

  const active = layers.find((l) => l.id === activeLayerId);

  return (
    <div className="timeline">
      <ol className="timeline__track">
        {layers.map((layer, i) => (
          <Frame
            key={layer.id}
            layer={layer}
            index={i}
            isActive={layer.id === activeLayerId}
            onSelect={onSelect}
          />
        ))}
        {pending && (
          <Frame
            key="pending"
            layer={{ id: 'pending', label: pending.label }}
            index={layers.length}
            isPending
            onSelect={() => {}}
          />
        )}
      </ol>

      {active && active.notes && (
        <p className="timeline__notes" key={active.id}>
          {active.notes}
        </p>
      )}
    </div>
  );
}
