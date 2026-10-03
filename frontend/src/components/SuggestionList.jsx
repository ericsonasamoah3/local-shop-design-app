export default function SuggestionList({ suggestions, message, coverage, onSelect, selectingProductId }) {
  if (message === 'no_shops_nearby') {
    if (coverage && coverage.status === 'gathering') {
      return (
        <p className="empty-note">
          We're finding shops near you now. This takes a few minutes the first time anyone
          searches your area. Your picks will appear here by themselves.
        </p>
      );
    }
    return (
      <p className="empty-note">
        We couldn't find shops near you that sell bedding online yet. We only list shops whose
        products we can read from their website.
      </p>
    );
  }

  if (message === 'category_coming_soon') {
    return <p className="empty-note">This space type isn't stocked yet in Phase 1 — try "Bed" instead.</p>;
  }

  if (message === 'no_matches_for_criteria' || suggestions.length === 0) {
    return <p className="empty-note">Nothing matched that budget/style combination. Try widening the budget.</p>;
  }

  const grouped = suggestions.reduce((acc, item) => {
    (acc[item.category] ||= []).push(item);
    return acc;
  }, {});

  let n = 0;

  return (
    <div>
      {Object.entries(grouped).map(([category, items]) => (
        <div className="category-group" key={category}>
          <h3 className="category-group__label">{category}</h3>
          <ul className="tag-grid">
            {items.map((item) => (
              // --i drives the entrance stagger in styles.css
              <li key={item.product_id} className="swing-tag" style={{ '--i': n++ }}>
                {item.shop_source_type === 'local' && <span className="stamp">Local</span>}
                <img className="swing-tag__image" src={item.image_url} alt={item.name} />
                <p className="swing-tag__name">{item.name}</p>
                <p className="swing-tag__price">£{item.price.toFixed(2)}</p>
                <p className="swing-tag__shop">
                  {item.shop_name}
                  {item.distance_miles !== null && item.distance_miles !== undefined && (
                    <span className="swing-tag__distance"> · {item.distance_miles} mi away</span>
                  )}
                </p>
                <button
                  className="btn"
                  onClick={() => onSelect(item)}
                  disabled={selectingProductId === item.product_id}
                >
                  {selectingProductId === item.product_id ? 'Mark the spot…' : 'Preview in my space'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
