const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const uploadRoute = require('./routes/upload');
const suggestRoute = require('./routes/suggest');
const compositeRoute = require('./routes/composite');

const app = express();
const PORT = process.env.PORT || 3001;

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const COMPOSITE_DIR = path.join(__dirname, '..', 'composites');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(COMPOSITE_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Serve uploaded photos and mocked composites as static files.
// These paths must be proxied by nginx in the frontend container too —
// see frontend/nginx.conf.
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/composites', express.static(COMPOSITE_DIR));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.use('/api/upload', uploadRoute);
app.use('/api/suggest', suggestRoute);
app.use('/api/composite', compositeRoute);

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
