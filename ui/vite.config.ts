import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // The app is served under /app in production so `/` can be a public
  // landing page (ui/public/landing.html) that never touches Cognito auth —
  // the ALB only exempts exact paths (`/`, `/logged-out`) from auth, so the
  // protected SPA and its assets all need to live under one auth-gated
  // prefix instead of at the root.
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:3001',
    },
  },
});
