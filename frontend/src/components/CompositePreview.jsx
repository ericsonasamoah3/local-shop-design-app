export default function CompositePreview({ status, compositeUrl, error }) {
  if (status === 'processing') {
    return (
      <div className="polaroid polaroid--pending">
        <p className="polaroid__caption">Generating your preview…</p>
      </div>
    );
  }

  if (status === 'failed' || error) {
    return (
      <p role="alert">
        Couldn't generate a preview right now ({error || 'unknown error'}). You can still view the
        product details above.
      </p>
    );
  }

  if (!compositeUrl) return null;

  return (
    <div className="polaroid">
      <div className="polaroid__tape" aria-hidden="true" />
      <img src={compositeUrl} alt="Composite preview of the selected item in your space" />
      <p className="polaroid__caption">your space, composited</p>
    </div>
  );
}
