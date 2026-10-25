// 文章列表增量同步。列表开头有置顶文章，其余部分也不严格按时间排序，所以不能遇到已知文章就停止：
// 以 updateTime 判断文章是否变化，连续 overlapPages 页（不计置顶）没有变化才结束头部扫描。
// 首次同步可能超过单次上限，未扫描完的部分记录在 backfillPage，下次从该页继续（断点续传）。
import type { ArticleSourceSyncState } from "@nyz-rag/types";
import { ArticleApiError, type ArticleClient, type ArticleListItem } from "./client.js";

export interface ArticleSyncOptions {
  client: Pick<ArticleClient, "list">;
  /** 已入库文章：articleKey → 来源 updateTime（毫秒）。 */
  known: Map<string, number | null>;
  state: ArticleSourceSyncState;
  /** 单次同步最多处理的文章数（每篇一次详情请求）。 */
  limit: number;
  overlapPages: number;
  perPage?: number;
  /** 完成回填后默认每 7 天全量刷新详情；用完成时间而不是任务次数计算。 */
  fullInspectionIntervalMs?: number;
  now?: () => Date;
  /** 获取详情并入库；抛出非 fatal 错误时记录失败并继续。 */
  process: (item: ArticleListItem) => Promise<void>;
  saveState: (state: ArticleSourceSyncState) => Promise<void>;
  /** 每次请求之间的等待。 */
  pause: () => Promise<void>;
  /** 每篇文章处理完（成功或失败）后调用。 */
  onProgress?: (progress: { processed: number; failed: number }) => Promise<void> | void;
}

export interface ArticleSyncResult {
  processed: number;
  failures: Array<{ articleKey: string; error: string }>;
  pages: number;
  /** 达到单次上限后提前结束，剩余文章留到下次同步。 */
  limitReached: boolean;
}

const MAX_RETRY_KEYS = 500;
const errorText = (error: unknown) => error instanceof Error ? error.message.slice(0, 300) : "未知错误";

export async function syncArticles(options: ArticleSyncOptions): Promise<ArticleSyncResult> {
  const { client, known, limit, overlapPages } = options;
  const perPage = options.perPage ?? 10;
  const state: ArticleSourceSyncState = { ...options.state };
  const now = options.now ?? (() => new Date());
  const fullInterval = options.fullInspectionIntervalMs ?? 7 * 24 * 60 * 60_000;
  if (state.backfillDone && !state.fullInspection &&
      (!state.lastFullInspectionAt || now().getTime() - Date.parse(state.lastFullInspectionAt) >= fullInterval)) {
    state.fullInspection = { page: 1, completedKeys: [] };
  } else if (state.fullInspection) {
    state.fullInspection = { ...state.fullInspection, completedKeys: [...state.fullInspection.completedKeys] };
  }
  const result: ArticleSyncResult = { processed: 0, failures: [], pages: 0, limitReached: false };
  const failedKeys = new Set<string>();
  const done = new Set<string>();
  const previousRetries = state.retryKeys ?? [];
  const checkpoint = async () => {
    const retry = [...failedKeys, ...previousRetries.filter((key) => !done.has(key))];
    if (retry.length) state.retryKeys = [...new Set(retry)].slice(0, MAX_RETRY_KEYS);
    else delete state.retryKeys;
    await options.saveState(state);
  };
  // 列表与详情请求之间统一限速，第一次请求不等待。
  let requests = 0;
  const paced = async <T>(run: () => Promise<T>) => { if (requests++ > 0) await options.pause(); return run(); };

  // 返回 false 表示已达上限。fatal 错误（token 失效等）直接中止。
  async function handle(item: ArticleListItem): Promise<boolean> {
    if (done.has(item._key)) return true;
    if (result.processed + result.failures.length >= limit) { result.limitReached = true; return false; }
    done.add(item._key);
    try {
      await paced(() => options.process(item));
      result.processed += 1;
    } catch (error) {
      if (error instanceof ArticleApiError && error.fatal) { failedKeys.add(item._key); throw error; }
      result.failures.push({ articleKey: item._key, error: errorText(error) });
      failedKeys.add(item._key);
    }
    await options.onProgress?.({ processed: result.processed, failed: result.failures.length });
    return true;
  }
  const changed = (item: ArticleListItem) => !known.has(item._key) || (item.updateTime !== undefined && known.get(item._key) !== item.updateTime);

  try {
    if (state.fullInspection) {
      // 全量巡检不使用 quietPages，也不依赖 updateTime。只刷新成功取得的详情，不推断删除。
      const cursor = state.fullInspection;
      // 巡检优先前进，避免失败重试耗尽每次预算、永久饿死历史页扫描。
      await checkpoint();
      while (true) {
        const { items, total } = await paced(() => client.list(cursor.page, perPage));
        result.pages += 1;
        if (cursor.page === 1 && total !== undefined) state.remoteTotal = total;
        if (!items.length) {
          delete state.fullInspection;
          state.lastFullInspectionAt = now().toISOString();
          return result;
        }
        for (const item of items) {
          if (cursor.completedKeys.includes(item._key)) continue;
          if (!await handle(item)) return result;
          cursor.completedKeys.push(item._key);
          await checkpoint();
        }
        cursor.page += 1;
        cursor.completedKeys = [];
        await checkpoint();
      }
    }

    // 增量同步优先重试；巡检中的失败保留到后续同步，不影响完整列表遍历。
    for (const key of previousRetries) if (!await handle({ _key: key })) return result;

    let page = 1;
    let quietPages = 0;
    let jumped = false;
    while (true) {
      const { items, total } = await paced(() => options.client.list(page, perPage));
      result.pages += 1;
      // 第 1 页的总数代表接口当前的文章规模，供管理端对比已入库数量。
      if (page === 1 && total !== undefined) state.remoteTotal = total;
      if (!items.length) {
        if (!state.backfillDone) state.lastFullInspectionAt = now().toISOString();
        state.backfillDone = true;
        delete state.backfillPage;
        break;
      }
      let pageChanged = false;
      for (const item of items) {
        if (!changed(item)) continue;
        if (!item.top) pageChanged = true;
        if (!await handle(item)) return result;
      }
      // 第 1～page 页已完整扫描过，回填进度不会落后于此。
      if (!state.backfillDone) state.backfillPage = Math.max(state.backfillPage ?? 1, page + 1);
      quietPages = pageChanged ? 0 : quietPages + 1;
      if (quietPages >= overlapPages) {
        if (state.backfillDone) break;
        // 头部已无变化，跳到上次回填位置；回退一页以覆盖新文章导致的列表下移。
        if (!jumped && (state.backfillPage ?? 1) - 1 > page + 1) {
          jumped = true;
          quietPages = 0;
          page = state.backfillPage! - 1;
          continue;
        }
      }
      page += 1;
    }
    return result;
  } finally {
    await checkpoint();
  }
}
