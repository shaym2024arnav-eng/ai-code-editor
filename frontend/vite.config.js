import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Monaco is bundled on purpose (no CDN at runtime); its TypeScript worker alone is several MB
  // but only loads when a JS/TS file is opened.
  build: { chunkSizeWarningLimit: 8000 },
  server: {
    port: 5173,
    // In development, /api goes to the local backend so no CORS setup is needed.
    proxy: { "/api": "http://localhost:5000" },
  },
});
