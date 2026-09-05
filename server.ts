import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';

import { checkDbStatus, initDbSchema } from './server/db.js';
import { authRouter } from './server/routes/auth.js';
import { adminRouter } from './server/routes/admin.js';
import { canvasesRouter } from './server/routes/canvases.js';
import { chatRouter } from './server/routes/chat.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Security headers with Helmet (per Spec 1.2)
app.use(
  helmet({
    contentSecurityPolicy: false, // Allow inline styles/scripts for Vite & Math rendering
    crossOriginEmbedderPolicy: false,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

// Database Diagnostics
app.get('/api/db/status', async (_req, res) => {
  try {
    const status = await checkDbStatus();
    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to check database status' });
  }
});

// Mount modular sub-routers
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/canvases', canvasesRouter);
app.use('/api/chat', chatRouter);

async function start() {
  // Initialize DB in background
  initDbSchema().catch((err) => console.warn('Background initDbSchema warning:', err?.message || err));

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DeepDive enterprise server listening on http://0.0.0.0:${PORT}`);
  });
}

start();
