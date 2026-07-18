// PROTOTYPE — throwaway (wayfinder ticket 12).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5199 },
});
