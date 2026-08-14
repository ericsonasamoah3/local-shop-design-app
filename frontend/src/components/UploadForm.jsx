import { useState } from 'react';
import { uploadImage } from '../api/client';

export default function UploadForm({ onUploaded }) {
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [error, setError] = useState(null);

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus('loading');
    setError(null);

    try {
      const result = await uploadImage(file);
      setStatus('idle');
      onUploaded(result);
    } catch (err) {
      setStatus('error');
      setError(
        err.message === 'invalid_file_type'
          ? 'Please upload a JPG, PNG, or WebP image.'
          : err.message === 'file_too_large'
          ? 'Image is too large — max 5MB.'
          : 'Something went wrong uploading your photo. Please try again.'
      );
    }
  }

  return (
    <div>
      <label className="dropzone" htmlFor="photo-upload">
        <span className="dropzone__icon" aria-hidden="true">＋</span>
        <span className="dropzone__label">Drop a photo, or tap to upload</span>
        <span className="dropzone__hint">JPG · PNG · WEBP — up to 5MB</span>
        <input
          id="photo-upload"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileChange}
          disabled={status === 'loading'}
        />
      </label>
      {status === 'loading' && <p className="status-line" data-tone="loading">Uploading…</p>}
      {status === 'error' && <p className="status-line" role="alert" data-tone="error">{error}</p>}
    </div>
  );
}
