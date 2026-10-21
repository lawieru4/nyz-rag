import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

const envDir = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");
  return {
    plugins: [vue()],
    envDir,
    server: { port: Number(env.WEB_PORT ?? 5175), strictPort: true },
  };
});
