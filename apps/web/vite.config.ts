import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  // ATProto loopback OAuth clients may only redirect to 127.0.0.1 / [::1], and
  // the cookie must be set on the same origin the browser uses — so bind the
  // dev server to 127.0.0.1 rather than whatever "localhost" resolves to.
  server: { host: "127.0.0.1" },
  resolve: { tsconfigPaths: true },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
