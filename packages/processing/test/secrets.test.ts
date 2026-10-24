import assert from "node:assert/strict";
import { test } from "node:test";
import { listProviderModels } from "../src/models.js";
import { hasProviderCredential, providerCredential, providerOrigin, usableModel, type ModelProviderConfig } from "../src/provider.js";
import { decryptSecret, encryptSecret, providerSecretContext, SecretKeyError, secretKeyConfigured } from "../src/secrets.js";
import { embedChunks } from "../src/embedding.js";
import { noopLimiter } from "./admission-helpers.js";

const KEY = "unit-test-master-key-with-at-least-32-chars";

function withEnv(context: { after(fn: () => void): void }, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  context.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    id: "provider-1", name: "Compatible", provider: "compatible", baseUrl: "https://models.example/v1", credentialEnv: "", hasApiKey: false, enabled: true,
    createdAt: "", updatedAt: "", ...overrides,
  };
}

test("secrets round-trip, are bound to their context and need the same master key", (context) => {
  withEnv(context, { NYZ_SECRET_KEY: KEY });
  assert.equal(secretKeyConfigured(), true);
  const ciphertext = encryptSecret("sk-secret", "context-a");
  assert.doesNotMatch(ciphertext, /sk-secret/);
  assert.notEqual(encryptSecret("sk-secret", "context-a"), ciphertext, "a fresh IV is used for every encryption");
  assert.equal(decryptSecret(ciphertext, "context-a"), "sk-secret");
  assert.throws(() => decryptSecret(ciphertext, "context-b"), SecretKeyError, "ciphertext cannot be moved to another context");
  assert.throws(() => decryptSecret("garbage", "context-a"), SecretKeyError);

  process.env.NYZ_SECRET_KEY = `${KEY}-rotated`;
  assert.throws(() => decryptSecret(ciphertext, "context-a"), (error: Error) => error instanceof SecretKeyError && !error.message.includes("sk-secret"));
  process.env.NYZ_SECRET_KEY = "too-short";
  assert.equal(secretKeyConfigured(), false);
  assert.throws(() => encryptSecret("x", "context-a"), /至少需要 32 个字符/);
  delete process.env.NYZ_SECRET_KEY;
  assert.throws(() => encryptSecret("x", "context-a"), /未配置 NYZ_SECRET_KEY/);
});

test("provider credentials prefer the saved key, fall back to the environment and allow no key", (context) => {
  withEnv(context, { NYZ_SECRET_KEY: KEY, SECRETS_TEST_KEY: "env-secret", SECRETS_TEST_MISSING: undefined, NYZ_MODEL_CREDENTIAL_ENVS: "SECRETS_TEST_KEY, SECRETS_TEST_MISSING" });
  const saved = provider({ apiKeyCiphertext: encryptSecret("saved-secret", providerSecretContext("provider-1")), credentialEnv: "SECRETS_TEST_KEY" });
  assert.equal(providerCredential(saved, "chat"), "saved-secret");
  assert.equal(providerCredential(provider({ credentialEnv: "SECRETS_TEST_KEY" }), "chat"), "env-secret");
  assert.equal(providerCredential(provider(), "chat"), null, "local models need no credential");
  assert.equal(hasProviderCredential(provider()), true);
  assert.throws(() => providerCredential(provider({ credentialEnv: "SECRETS_TEST_MISSING" }), "chat"), /credential is missing/);
  assert.equal(hasProviderCredential(provider({ credentialEnv: "SECRETS_TEST_MISSING" })), false);
  // A key saved for another provider cannot be reused by copying the ciphertext.
  assert.equal(hasProviderCredential({ ...saved, id: "provider-2" }), false);
});

test("credentialEnv can only read allow-listed environment variables", (context) => {
  withEnv(context, { NYZ_SECRET_KEY: KEY, SECRETS_TEST_KEY: "env-secret", NYZ_MODEL_CREDENTIAL_ENVS: undefined });
  // 默认名单为空：任何环境变量都不会被当作密钥，也不会退回为不带认证头的调用。
  assert.throws(() => providerCredential(provider({ credentialEnv: "SECRETS_TEST_KEY" }), "chat"), (error: Error) => /not allowed/.test(error.message) && !error.message.includes("env-secret"));
  assert.throws(() => providerCredential(provider({ credentialEnv: "NYZ_SECRET_KEY" }), "chat"), /not allowed/);
  assert.equal(hasProviderCredential(provider({ credentialEnv: "SECRETS_TEST_KEY" })), false);
  process.env.NYZ_MODEL_CREDENTIAL_ENVS = "OTHER_KEY,SECRETS_TEST_KEY";
  assert.equal(providerCredential(provider({ credentialEnv: "SECRETS_TEST_KEY" }), "chat"), "env-secret");
  assert.throws(() => providerCredential(provider({ credentialEnv: "NYZ_SECRET_KEY" }), "chat"), /not allowed/);
});

test("provider origins resolve the default OpenAI address and ignore the path", () => {
  assert.equal(providerOrigin({ name: "OpenAI", provider: "openai", baseUrl: "" }), "https://api.openai.com");
  assert.equal(providerOrigin({ name: "x", provider: "x", baseUrl: "https://models.example/v1/" }), "https://models.example");
  assert.notEqual(providerOrigin({ name: "x", provider: "x", baseUrl: "https://models.example:8443/v1" }), "https://models.example");
  assert.equal(providerOrigin({ name: "x", provider: "x", baseUrl: "" }), null);
});

test("a configured model is usable only when its provider credential is available", (context) => {
  withEnv(context, { SECRETS_TEST_MISSING: undefined, NYZ_MODEL_CREDENTIAL_ENVS: "SECRETS_TEST_MISSING" });
  const local = { provider: provider(), model: "embed" };
  assert.equal(usableModel(local), local, "local models need no credential");
  assert.equal(usableModel(null), null);
  assert.equal(usableModel({ provider: provider({ credentialEnv: "SECRETS_TEST_MISSING" }), model: "chat" }), null);
});

test("requests without a credential omit the authorization header; model lists are parsed and sorted", async (context) => {
  const oldFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = oldFetch; });
  const headers: Array<Headers> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    if (String(input).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "b-model" }, { id: "" }, {}] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }), { status: 200 });
  }) as typeof fetch;

  await embedChunks({ provider: provider(), model: "embed" }, ["text"], noopLimiter());
  assert.equal(headers[0].has("authorization"), false);
  assert.deepEqual(await listProviderModels(provider(), "list-secret"), ["a-model", "b-model"]);
  assert.equal(headers[1].get("authorization"), "Bearer list-secret");

  globalThis.fetch = (async () => new Response("provider-body-secret", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(listProviderModels(provider(), null), (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes("provider-body-secret"));
});
