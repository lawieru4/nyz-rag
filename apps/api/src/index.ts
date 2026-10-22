import { closeDatabase, closeModelAdmissionLimiter, migrate, modelAdmissionConfig } from "@nyz-rag/processing";
import { buildApp } from "./app.js";

modelAdmissionConfig();
const app = buildApp({ logger: true });
const port = Number(process.env.API_PORT ?? 3000);
app.addHook("onClose", closeDatabase);
app.addHook("onClose", closeModelAdmissionLimiter);
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
