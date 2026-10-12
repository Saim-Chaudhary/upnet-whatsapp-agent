import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "dashboard",
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
  },
});
