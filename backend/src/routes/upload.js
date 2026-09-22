const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { UPLOAD_DIR, MIME_TO_EXTENSION } = require('../services/uploadStore');

const router = express.Router();

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = Object.keys(MIME_TO_EXTENSION);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uploadId = uuidv4();
    req.generatedUploadId = uploadId;
    // The extension comes from the MIME type fileFilter already validated, not
    // from the client-supplied filename. Deriving it from originalname would
    // let a caller choose the extension of a file we then serve back from
    // /uploads, since the browser picks the mimetype too.
    cb(null, `${uploadId}${MIME_TO_EXTENSION[file.mimetype]}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('invalid_file_type'));
    }
    cb(null, true);
  },
});

router.post('/', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'file_too_large' });
      }
      if (err.message === 'invalid_file_type') {
        return res.status(400).json({ error: 'invalid_file_type' });
      }
      return res.status(400).json({ error: 'upload_failed' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'no_file_provided' });
    }

    const uploadId = req.generatedUploadId;
    const extension = MIME_TO_EXTENSION[req.file.mimetype];

    res.status(200).json({
      upload_id: uploadId,
      image_url: `/uploads/${uploadId}${extension}`,
      created_at: new Date().toISOString(),
    });
  });
});

module.exports = router;
