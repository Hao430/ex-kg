import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';

import { initDbSchema } from './server/core/schema.js';
import { createApp } from './server/app.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = createApp();
const PORT = Number(process.env.PORT) || 3000;

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
