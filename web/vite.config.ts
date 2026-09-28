import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root, plugins: [react()], build: { outDir: 'dist', emptyOutDir: true }, server: { host: '127.0.0.1' } });
