import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // react-grid-layout's `react-draggable` reads `process.env.*` at runtime inside
  // the drag/resize lifecycle; the browser has no `process`, so without these the
  // handlers throw "process is not defined" and drag/resize silently abort.
  define: {
    "process.env.DRAGGABLE_DEBUG": "false",
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  server: {
    port: 5173,
    proxy: {
      // Forward API + auth traffic to the Bun server during development.
      "/api": "http://localhost:3000",
    },
  },
}))
