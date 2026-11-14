import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Під час розробки (`npm run dev`) запити /api ідуть на сервер FastAPI на порту 8000.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8000", ws: true },
    },
  },
});
