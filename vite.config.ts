import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";

export default defineConfig({
  // Keep Vite's root and resolved entry on the same physical path when the
  // workspace is opened through a Windows junction.
  root: realpathSync("."),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5188,
  },
});
