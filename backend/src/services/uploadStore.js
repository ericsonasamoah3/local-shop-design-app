const fs = require('fs');
const path = require('path');

// Single place that knows how uploaded photos are named on disk, shared by
// routes/suggest.js and compositeService.js so the two can't drift apart.
//
// routes/upload.js only ever writes `{uuid}{ext}` where ext comes from the
// validated MIME type below, so finding an upload is three existsSync calls
// rather than a synchronous readdir of the whole directory on every request.

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

const MIME_TO_EXTENSION = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const ALLOWED_EXTENSIONS = Object.values(MIME_TO_EXTENSION);

const EXTENSION_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// An upload_id is always a uuid we generated. Checking that before touching
// the filesystem keeps a caller-supplied id from walking out of UPLOAD_DIR.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function findUploadPath(uploadId) {
  if (typeof uploadId !== 'string' || !UUID_PATTERN.test(uploadId)) return null;

  for (const ext of ALLOWED_EXTENSIONS) {
    const candidate = path.join(UPLOAD_DIR, `${uploadId}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function uploadExists(uploadId) {
  return findUploadPath(uploadId) !== null;
}

function mimeForPath(filePath) {
  return EXTENSION_TO_MIME[path.extname(filePath).toLowerCase()] || 'image/jpeg';
}

module.exports = {
  UPLOAD_DIR,
  MIME_TO_EXTENSION,
  ALLOWED_EXTENSIONS,
  findUploadPath,
  uploadExists,
  mimeForPath,
};
