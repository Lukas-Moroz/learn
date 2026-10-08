import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is built into dist/web and served by the local server. In `npm run dev`,
// Vite serves the client and proxies /api to the server.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4317" } },
});
