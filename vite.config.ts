import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2021", outDir: "dist" },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/pages/__tests__/setup.ts" },
} as any);
