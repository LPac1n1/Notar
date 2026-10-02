import { defineConfig } from "@playwright/test";
import process from "node:process";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "on-first-retry",
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: [
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4173",
      env: {
        ...process.env,
        VITE_NOTAR_AUTH_MODE: "local",
      },
      url: "http://127.0.0.1:4173",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    // Segundo servidor, em modo NUVEM, apontado para o storage de mentira
    // que `e2e/cloud-sync.spec.js` sobe na porta 4175. O modo de
    // autenticação e o endereço do Supabase são fixados em tempo de build
    // do dev server, então o mesmo servidor não serve aos dois casos.
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4174",
      env: {
        ...process.env,
        VITE_NOTAR_AUTH_MODE: "",
        VITE_SUPABASE_URL: "http://127.0.0.1:4175",
        VITE_SUPABASE_ANON_KEY: "chave-publica-de-mentira",
        VITE_SUPABASE_STORAGE_BUCKET: "notar",
        VITE_SUPABASE_STORAGE_OBJECT: "dados.json",
      },
      url: "http://127.0.0.1:4174",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
