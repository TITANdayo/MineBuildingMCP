import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    port: 5173,
    strictPort: false,
    host: "127.0.0.1"
  },
  build: {
    outDir: "dist/viewer",
    emptyOutDir: true
  }
});
