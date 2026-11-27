import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Relative base: the same build serves at the origin root (Desktop) or under a gateway prefix such as /castudio/ (Web).
export default defineConfig({ base: './', plugins: [react()], resolve: { dedupe: ['@codemirror/state', '@codemirror/view'] }, server: { host: '127.0.0.1' }, build: { outDir: 'dist', chunkSizeWarningLimit: 1500 } });
