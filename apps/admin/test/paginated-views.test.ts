import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { usePaginatedList } from "../src/composables/usePaginatedList.ts";

async function flush() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function mountView(name: string) {
  const requests: Array<{ path: string; init: RequestInit; resolve: (value: any) => void; reject: (error: unknown) => void }> = [];
  const errors: string[] = [];
  const successes: string[] = [];
  let knowledgeLoads = 0;
  const { descriptor } = parse(readFileSync(new URL(`../src/views/${name}.vue`, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: name }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  // Run the real SFC setup and lifecycle, replacing only I/O and unrendered UI imports.
  new Function("require", "exports", compiled)((id: string) => {
    if (id === "vue") return vue;
    if (id === "../composables/usePaginatedList") return { usePaginatedList };
    if (id === "../workspace") return {
      pageSize: 10,
      client: { request: (path: string, init: RequestInit = {}) => new Promise((resolve, reject) => requests.push({ path, init, resolve, reject })) },
      loadKnowledge: async () => { knowledgeLoads++; },
      errorMessage: (_error: unknown, fallback: string) => fallback,
    };
    if (id === "@nyz-rag/ui/lib/toast") return { toast: { error: (message: string) => errors.push(message), success: (message: string) => successes.push(message) } };
    if (id === "@nyz-rag/ui/confirm") return { confirm: async () => true };
    return {};
  }, exports);
  const renderer = vue.createRenderer<object, object>({
    patchProp() {}, insert() {}, remove() {},
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
  });
  let view: any;
  const app = renderer.createApp(vue.defineComponent({
    setup() {
      view = exports.default.setup({}, { expose() {} });
      return () => null;
    },
  }));
  app.mount({});
  return { view, requests, errors, successes, unmount: () => app.unmount(), knowledgeLoads: () => knowledgeLoads };
}

test("documents retain filters, 3-second polling, status merge and detail refresh without selection races", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { view, requests, errors, unmount } = mountView("DocumentsView");
  t.after(unmount);
  const summary = { id: "a", title: "Article", updatedAt: "v1", processingStatus: "pending" };
  requests[0].resolve({ documents: [summary], total: 1 });
  await flush();
  const open = view.openDocument("a");
  requests[1].resolve({ ...summary, content: "body", chunks: [] });
  await open;
  t.mock.timers.tick(3000);
  assert.equal(requests.length, 3);
  t.mock.timers.tick(3000);
  assert.equal(requests.length, 3, "polling skips an in-flight list request");
  requests[2].resolve({ documents: [{ ...summary, processingStatus: "chunked" }], total: 1 });
  await flush();
  assert.equal(view.selected.value.content, "body");
  assert.equal(view.selected.value.processingStatus, "chunked");
  t.mock.timers.tick(3000);
  requests[3].resolve({ documents: [{ ...summary, updatedAt: "v2" }], total: 1 });
  await flush();
  assert.equal(requests[4].path, "/api/admin/documents/a", "changed content refreshes detail");
  const openOther = view.openDocument("b");
  assert.equal(requests[4].init.signal?.aborted, true);
  requests[5].resolve({ id: "b", updatedAt: "v1", content: "other" });
  await openOther;
  requests[4].resolve({ ...summary, updatedAt: "v2", content: "stale" });
  await flush();
  assert.equal(view.selected.value.id, "b");
  view.query.value = "  storage  ";
  view.search();
  t.mock.timers.tick(3000);
  assert.equal(requests.length, 7, "pending search is not duplicated by polling");
  assert.equal(new URL(requests[6].path, "http://test").searchParams.get("query"), "storage");
  view.page.value = 4;
  view.sourceId.value = "source-1";
  view.status.value = "failed";
  view.filter();
  const params = new URL(requests[7].path, "http://test").searchParams;
  assert.equal(params.get("page"), "1");
  assert.equal(params.get("sourceId"), "source-1");
  assert.equal(params.get("status"), "failed");
  assert.equal(requests[6].init.signal?.aborted, true);
  const pendingDetail = view.openDocument("c");
  view.closeDocument();
  assert.equal(requests[8].init.signal?.aborted, true);
  requests[8].resolve({ id: "c", content: "closed" });
  await pendingDetail;
  assert.equal(view.selected.value, null);
  const unmountedDetail = view.openDocument("d");
  unmount();
  assert.equal(requests[7].init.signal?.aborted, true);
  assert.equal(requests[9].init.signal?.aborted, true);
  requests[9].reject(new Error("cancelled"));
  await unmountedDetail;
  t.mock.timers.tick(6000);
  assert.equal(requests.length, 10);
  assert.deepEqual(errors, []);
});

test("document deletion retains last-row page fallback and shared knowledge refresh", async (t) => {
  const { view, requests, knowledgeLoads, successes, unmount } = mountView("DocumentsView");
  t.after(unmount);
  const document = { id: "a", title: "Article", updatedAt: "v1" };
  requests[0].resolve({ documents: [document], total: 11 });
  await flush();
  view.page.value = 2;
  const deletion = view.deleteDocument(document);
  await flush();
  assert.equal(requests[1].init.method, "DELETE");
  requests[1].resolve(undefined);
  await flush();
  assert.equal(view.page.value, 1);
  assert.equal(new URL(requests[2].path, "http://test").searchParams.get("page"), "1");
  requests[2].resolve({ documents: [], total: 10 });
  await deletion;
  assert.equal(knowledgeLoads(), 1);
  assert.deepEqual(successes, ["文档已删除"]);
});

test("users retain account toggle behavior and current-page list replacement", async (t) => {
  const { view, requests, successes, unmount } = mountView("UsersView");
  t.after(unmount);
  const user = { id: "u", email: "user@example.com", disabled: false };
  requests[0].resolve({ users: [user], total: 1 });
  await flush();
  const toggle = view.toggleUser(user);
  await flush();
  assert.equal(requests[1].path, "/api/admin/users/u");
  assert.equal(requests[1].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[1].init.body as string), { disabled: true });
  requests[1].resolve({ ...user, disabled: true });
  await toggle;
  assert.equal(view.users.value[0].disabled, true);
  assert.equal(view.total.value, 1);
  assert.deepEqual(successes, ["已停用 user@example.com"]);
});

test("chat logs retain page-owned rating filters and selected details across list loads", async (t) => {
  const { view, requests, unmount } = mountView("ChatLogsView");
  t.after(unmount);
  const log = { id: "log", question: "Question", answer: "Answer", sources: [], chunks: [], rating: null };
  requests[0].resolve({ logs: [log], total: 1 });
  await flush();
  view.selected.value = log;
  view.page.value = 3;
  view.rating.value = "rated";
  view.query.value = "  question  ";
  view.filter();
  const params = new URL(requests[1].path, "http://test").searchParams;
  assert.equal(params.get("page"), "1");
  assert.equal(params.get("query"), "question");
  assert.equal(params.get("rating"), "rated");
  requests[1].resolve({ logs: [], total: 0 });
  await flush();
  assert.deepEqual(view.logs.value, []);
  assert.equal(view.selected.value.id, "log");
});
