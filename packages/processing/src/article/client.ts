// nyzdata 文章接口客户端。token 只作为查询参数发送，不出现在错误信息与日志中。
import type { ArticleDetail } from "./parse.js";

export interface ArticleListItem {
  _key: string;
  title?: string;
  createTime?: number;
  updateTime?: number;
  /** 置顶文章，列表开头固定出现，不代表时间顺序。 */
  top?: number;
}

export interface ArticleClient {
  list(page: number, perPage: number): Promise<ArticleListItem[]>;
  detail(articleKey: string): Promise<ArticleDetail>;
  /** 文章在站点上的页面地址，作为文档 URL。 */
  articleUrl(articleKey: string): string;
}

/** fatal 表示继续请求也不会成功（如 token 失效），应中止整次同步。 */
export class ArticleApiError extends Error {
  constructor(message: string, readonly fatal = false) {
    super(message);
    this.name = "ArticleApiError";
  }
}

/**
 * listUrl 为文章列表接口地址，例如 https://nyzdata.nenghe.com/nyzfoxx/article?tagKey=9302258412；
 * 详情接口为同一路径下的 /articleDetail。其余查询参数（tagKey、type、sort）原样保留。
 */
export function createArticleClient(options: { listUrl: string; token: string; timeoutMs?: number; fetch?: typeof fetch }): ArticleClient {
  const listUrl = new URL(options.listUrl);
  if (!["http:", "https:"].includes(listUrl.protocol)) throw new ArticleApiError("文章接口地址必须是 http(s)", true);
  if (listUrl.searchParams.has("token")) throw new ArticleApiError("文章接口地址不能包含 token，请通过环境变量配置", true);
  if (!options.token.trim()) throw new ArticleApiError("未配置文章接口 token，请在管理后台数据源页面填写", true);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  const detailPath = `${listUrl.pathname.replace(/\/$/, "")}/articleDetail`;

  async function getJson<T>(pathname: string, params: Record<string, string | number>, label: string): Promise<T> {
    const url = new URL(listUrl);
    url.pathname = pathname;
    if (pathname !== listUrl.pathname) url.search = "";
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    url.searchParams.set("token", options.token);
    let response: Response;
    try {
      response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    } catch (error) {
      // 网络错误信息可能包含完整 URL，只保留错误类型。
      throw new ArticleApiError(`${label}请求失败（${error instanceof Error ? error.name : "network error"}）`);
    }
    if (response.status === 401 || response.status === 403) throw new ArticleApiError(`${label}被拒绝（HTTP ${response.status}），请检查 token`, true);
    if (!response.ok) throw new ArticleApiError(`${label}失败（HTTP ${response.status}）`);
    const body = await response.json().catch(() => null) as { status?: number; msg?: string; data?: T } | null;
    if (!body || body.status !== 200) throw new ArticleApiError(`${label}失败（status ${body?.status ?? "invalid"}${body?.msg ? `：${String(body.msg).slice(0, 100)}` : ""}）`);
    return body.data as T;
  }

  return {
    async list(page, perPage) {
      const params: Record<string, string | number> = { curPage: page, perPage };
      if (!listUrl.searchParams.has("type")) params.type = 2;
      if (!listUrl.searchParams.has("sort")) params.sort = "desc";
      const data = await getJson<{ list?: ArticleListItem[] }>(listUrl.pathname, params, "文章列表");
      return data?.list ?? [];
    },
    async detail(articleKey) {
      const data = await getJson<ArticleDetail>(detailPath, { articleKey }, "文章详情");
      if (!data) throw new ArticleApiError(`文章 ${articleKey} 详情为空`);
      if (data.invalidToken) throw new ArticleApiError("文章接口 token 无效或已过期", true);
      if (!data.content) throw new ArticleApiError(`文章 ${articleKey} 没有正文（可能为 VIP 文章或无权限）`);
      return data;
    },
    articleUrl(articleKey) {
      return new URL(`/ArticleDetail?id=${encodeURIComponent(articleKey)}`, listUrl.origin).toString();
    },
  };
}
