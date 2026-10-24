import assert from "node:assert/strict";
import { test } from "node:test";
import { createRenderer, defineComponent } from "vue";
import { usePaginatedList } from "../src/composables/usePaginatedList.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function mountList() {
  type Result = { items: string[]; total: number };
  const requests: Array<ReturnType<typeof deferred<Result>> & { params: URLSearchParams; signal: AbortSignal }> = [];
  const errors: unknown[] = [];
  const loaded: string[][] = [];
  let rating = "";
  let list!: ReturnType<typeof usePaginatedList<string>>;
  // Vue's renderer exercises actual mounted/unmounted hooks without a DOM dependency.
  const renderer = createRenderer<object, object>({
    patchProp() {}, insert() {}, remove() {},
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {},
    parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp(defineComponent({
    setup() {
      list = usePaginatedList<string>({
        pageSize: 10,
        fetch(params, signal) {
          if (rating) params.set("rating", rating);
          const request = { ...deferred<Result>(), params, signal };
          requests.push(request);
          return request.promise;
        },
        onLoaded: (items) => { loaded.push(items); },
        onError: (error) => { errors.push(error); },
      });
      return () => null;
    },
  }));
  app.mount({});
  return { list, requests, errors, loaded, unmount: () => app.unmount(), setRating: (value: string) => { rating = value; } };
}

test("mount loads page one; reload trims queries and preserves pagination", async (t) => {
  const harness = mountList();
  t.after(harness.unmount);
  const { list, requests, loaded } = harness;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.toString(), "page=1&pageSize=10");
  assert.equal(list.loading.value, true);
  requests[0].resolve({ items: ["first"], total: 21 });
  await flush();
  assert.deepEqual(list.items.value, ["first"]);
  assert.equal(list.total.value, 21);
  assert.equal(list.loading.value, false);
  list.page.value = 3;
  list.query.value = "  email@example.com  ";
  const load = list.load();
  assert.equal(requests[1].params.get("page"), "3");
  assert.equal(requests[1].params.get("query"), "email@example.com");
  requests[1].resolve({ items: ["third"], total: 21 });
  await load;
  assert.deepEqual(loaded, [["first"], ["third"]]);
  assert.equal(list.page.value, 3);
});

test("a newer request wins even when the old transport ignores abort", async (t) => {
  const harness = mountList();
  t.after(harness.unmount);
  const { list, requests, errors, loaded } = harness;
  const latest = list.load();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ items: ["new"], total: 2 });
  await latest;
  requests[0].resolve({ items: ["stale"], total: 99 });
  await flush();
  assert.deepEqual(list.items.value, ["new"]);
  assert.equal(list.total.value, 2);
  assert.equal(list.loading.value, false);
  assert.deepEqual(loaded, [["new"]]);
  assert.deepEqual(errors, []);
});

test("stale failures cannot clear the latest loading state or show an error", async (t) => {
  const harness = mountList();
  t.after(harness.unmount);
  const { list, requests, errors } = harness;
  const latest = list.load();
  requests[0].reject(new Error("old failure"));
  await flush();
  assert.equal(list.loading.value, true);
  assert.deepEqual(errors, []);
  const failure = new Error("current failure");
  requests[1].reject(failure);
  await latest;
  assert.equal(list.loading.value, false);
  assert.deepEqual(errors, [failure]);
});

test("search resets the page, immediately invalidates old data, and debounces for 250ms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = mountList();
  t.after(harness.unmount);
  const { list, requests, loaded } = harness;
  list.page.value = 4;
  list.query.value = "old search";
  list.search();
  assert.equal(list.page.value, 1);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ items: ["stale"], total: 1 });
  await flush();
  assert.deepEqual(loaded, []);
  t.mock.timers.tick(200);
  list.query.value = "  latest search  ";
  list.search();
  t.mock.timers.tick(249);
  assert.equal(requests.length, 1);
  // loading remains true during the debounce so page polling cannot bypass it.
  assert.equal(list.loading.value, true);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].params.get("page"), "1");
  assert.equal(requests[1].params.get("query"), "latest search");
  requests[1].resolve({ items: ["match"], total: 1 });
  await flush();
  assert.deepEqual(list.items.value, ["match"]);
  assert.equal(list.loading.value, false);
});

test("filter immediately loads page one and cancels pending search without losing page-owned parameters", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = mountList();
  t.after(harness.unmount);
  const { list, requests, setRating } = harness;
  list.query.value = "  question  ";
  list.search();
  list.page.value = 3;
  setRating("rated");
  list.filter();
  assert.equal(requests.length, 2);
  assert.equal(list.page.value, 1);
  assert.equal(requests[1].params.get("query"), "question");
  assert.equal(requests[1].params.get("rating"), "rated");
  t.mock.timers.tick(250);
  assert.equal(requests.length, 2);
  requests[1].resolve({ items: ["rated"], total: 1 });
  await flush();
  assert.deepEqual(list.items.value, ["rated"]);
});

test("errors retain the last successful data and whitespace-only search is omitted", async (t) => {
  const harness = mountList();
  t.after(harness.unmount);
  const { list, requests, errors } = harness;
  requests[0].resolve({ items: ["retained"], total: 3 });
  await flush();
  list.query.value = "   ";
  const load = list.load();
  assert.equal(requests[1].params.has("query"), false);
  requests[1].reject(new Error("unavailable"));
  await load;
  assert.deepEqual(list.items.value, ["retained"]);
  assert.equal(list.total.value, 3);
  assert.equal(errors.length, 1);
  assert.equal(list.loading.value, false);
});

test("unmount aborts requests, suppresses late success/failure, and blocks subsequent loads", async () => {
  for (const outcome of ["resolve", "reject"] as const) {
    const { list, requests, loaded, errors, unmount } = mountList();
    unmount();
    assert.equal(requests[0].signal.aborted, true);
    if (outcome === "resolve") requests[0].resolve({ items: ["late"], total: 1 });
    else requests[0].reject(new Error("late"));
    await flush();
    await list.load();
    assert.equal(requests.length, 1);
    assert.deepEqual(list.items.value, []);
    assert.equal(list.total.value, 0);
    assert.equal(list.loading.value, false);
    assert.deepEqual(loaded, []);
    assert.deepEqual(errors, []);
  }
});

test("unmount clears pending search timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { list, requests, unmount } = mountList();
  list.search();
  unmount();
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 1);
  list.search();
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 1);
});
