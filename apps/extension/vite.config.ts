import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { newtab: 'newtab.html', background: 'src/background.ts' }, output: { entryFileNames: '[name].js' } } },
});
