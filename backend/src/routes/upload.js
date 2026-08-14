const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uploadId = uuidv4();
    req.generatedUploadId = uploadId;
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uploadId}${ext}`);
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
    const filename = path.basename(req.file.path);

    res.status(200).json({
      upload_id: uploadId,
      image_url: `/uploads/${filename}`,
      created_at: new Date().toISOString(),
    });
  });
});

module.exports = router;
