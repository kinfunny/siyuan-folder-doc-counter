import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: "src/index.ts",
      formats: ["cjs"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["siyuan"],
      output: {
        assetFileNames: "style.css",
      },
    },
  },
});
