import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // Tauri expects a fixed port during dev.
  server: { port: 1420, strictPort: true },
  clearScreen: false,
});
