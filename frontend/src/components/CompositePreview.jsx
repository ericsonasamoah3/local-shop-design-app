// Error copy is keyed off the codes the backend actually returns, so a failure
// always says something specific rather than "unknown error". See CLAUDE.md
// section 6: never leave the user with a broken image and no explanation.
const ERROR_COPY = {
  missing_anthropic_key: 'The preview service is not configured yet.',
  missing_replicate_token: 'The preview service is not configured yet.',
  missing_replicate_model_version: 'The preview service is not configured yet.',
  invalid_replicate_model_version: 'The preview service is misconfigured.',
  invalid_anthropic_key: 'The preview service is not configured correctly.',
  rate_limited: "You've hit the preview limit for now. Try again a bit later.",
  model_provider_unavailable: 'The preview service is having trouble. Try again shortly.',
  replicate: "The preview didn't come out. Please try again.",
  product_image_unavailable: "We couldn't load this product's photo.",
  render_download_failed: "The preview didn't come out. Please try again.",
  composite_failed: 'Something went wrong generating the preview.',
  implausible_placement: "That spot doesn't work for this item.",
  empty_mask: "We couldn't read the area you marked — try drawing the box again.",
  invalid_mask_data: "We couldn't read the area you marked — try drawing the box again.",
  upload_file_not_found: 'We lost track of your photo. Please upload it again.',
  base_composite_not_found: 'That version is no longer available. Pick another frame and try again.',
  unreadable_room_photo: "We couldn't read your photo. Please upload it again.",
  render_timed_out: 'The preview took too long. Please try again.',
  render_failed: "The preview didn't come out. Please try again.",
  render_returned_no_image: "The preview didn't come out. Please try again.",
  composite_timed_out: 'The preview took too long. Please try again.',
  composite_not_found: 'That preview expired. Please try again.',
};

function describe(error) {
  if (!error) return 'Something went wrong.';
  if (ERROR_COPY[error]) return ERROR_COPY[error];
  if (error.startsWith('product_image_unavailable')) {
    return "We couldn't load this product's photo.";
  }
  if (error.startsWith('placement_plan')) {
    return "We couldn't work out how to place this item.";
  }
  if (error.startsWith('replicate_') || error.startsWith('render_')) {
    return "The preview didn't come out. Please try again.";
  }
  return 'Something went wrong generating the preview.';
}

export default function CompositePreview({ status, compositeUrl, error, notes }) {
  if (status === 'processing') {
    return (
      <div className="polaroid polaroid--pending">
        <p className="polaroid__caption">Generating your preview…</p>
      </div>
    );
  }

  if (status === 'failed' || error) {
    return (
      <div role="alert">
        <p>{describe(error)}</p>
        {notes && <p className="polaroid__note">{notes}</p>}
        <p>You can still view the product details above, or mark a different spot.</p>
      </div>
    );
  }

  if (!compositeUrl) return null;

  return (
    <div className="polaroid">
      <div className="polaroid__tape" aria-hidden="true" />
      <img src={compositeUrl} alt="Composite preview of the selected item in your space" />
      <p className="polaroid__caption">your space, filled in</p>
      {notes && <p className="polaroid__note">{notes}</p>}
    </div>
  );
}
