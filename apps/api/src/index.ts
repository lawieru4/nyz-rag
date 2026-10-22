import { closeDatabase, migrate } from "@nyz-rag/processing";
import { buildApp } from "./app.js";

const app = buildApp({ logger: true });
const port = Number(process.env.API_PORT ?? 3000);
app.addHook("onClose", closeDatabase);
process.once("SIGINT", () => void app.close());
process.once("SIGTERM", () => void app.close());

try {
  await migrate();
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
