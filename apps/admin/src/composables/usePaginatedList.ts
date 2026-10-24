import { onMounted, onScopeDispose, ref, shallowRef } from "vue";

type PaginatedListOptions<T> = {
  pageSize: number;
  fetch: (params: URLSearchParams, signal: AbortSignal) => Promise<{ items: T[]; total: number }>;
  onLoaded?: (items: T[]) => void;
  onError: (error: unknown) => void;
};

export function usePaginatedList<T>(options: PaginatedListOptions<T>) {
  const items = shallowRef<T[]>([]);
  const total = ref(0);
  const query = ref("");
  const page = ref(1);
  const loading = ref(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let disposed = false;

  function cancel() {
    clearTimeout(searchTimer);
    searchTimer = undefined;
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }

  async function load() {
    cancel();
    if (disposed) return;
    const request = new AbortController();
    controller = request;
    loading.value = true;
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(options.pageSize) });
    if (query.value.trim()) params.set("query", query.value.trim());
    try {
      const data = await options.fetch(params, request.signal);
      // Cancellation may race with response parsing, or a transport may ignore it.
      if (controller !== request || request.signal.aborted) return;
      items.value = data.items;
      total.value = data.total;
      options.onLoaded?.(data.items);
    } catch (error) {
      if (controller === request && !request.signal.aborted) options.onError(error);
    } finally {
      if (controller === request) {
        controller = undefined;
        loading.value = false;
      }
    }
  }

  function search() {
    cancel();
    if (disposed) return;
    page.value = 1;
    loading.value = true;
    searchTimer = setTimeout(() => void load(), 250);
  }

  function filter() {
    page.value = 1;
    void load();
  }

  onMounted(load);
  onScopeDispose(() => {
    disposed = true;
    cancel();
  });

  return { items, total, query, page, loading, load, search, filter };
}
