export default function SuggestionList({ suggestions, message, onSelect, selectingProductId }) {
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

  return (
    <div>
      {Object.entries(grouped).map(([category, items]) => (
        <div className="category-group" key={category}>
          <h3 className="category-group__label">{category}</h3>
          <ul className="tag-grid">
            {items.map((item) => (
              <li key={item.product_id} className="swing-tag">
                {item.shop_source_type === 'local' && <span className="stamp">Local</span>}
                <img className="swing-tag__image" src={item.image_url} alt={item.name} />
                <p className="swing-tag__name">{item.name}</p>
                <p className="swing-tag__price">£{item.price.toFixed(2)}</p>
                <p className="swing-tag__shop">{item.shop_name}</p>
                <button
                  className="btn"
                  onClick={() => onSelect(item.product_id)}
                  disabled={selectingProductId === item.product_id}
                >
                  {selectingProductId === item.product_id ? 'Generating…' : 'Preview in my space'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
