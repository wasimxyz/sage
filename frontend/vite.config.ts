import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    include: [
      "@tiptap/markdown",
      "@tiptap/react",
      "@tiptap/react/menus",
      "@tiptap/starter-kit",
    ],
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/eve": {
        changeOrigin: true,
        target: "http://127.0.0.1:2000",
      },
    },
    strictPort: true,
    warmup: {
      clientFiles: [
        "./src/components/editor.tsx",
        "./src/components/editor-bubble-menu.tsx",
      ],
    },
  },
});
