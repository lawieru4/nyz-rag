// 管理端概览（数据源、同步任务、统计）的实时推送。
// Worker 把同步进度写入数据库；有管理端连接时，进程内共用一个轮询读取概览，内容变化才推送给所有连接。
import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { KnowledgeOverview } from "@nyz-rag/types";
import { getStats, listSources, listTasks } from "@nyz-rag/processing";

export interface OverviewEventsOptions {
  load?: () => Promise<KnowledgeOverview>;
  /** 读取概览的间隔。 */
  intervalMs?: number;
  /** 单条连接的最长时长；到时由服务端关闭，浏览器自动重连并重新鉴权。 */
  maxDurationMs?: number;
  heartbeatMs?: number;
}

export async function loadOverview(): Promise<KnowledgeOverview> {
  const [sources, tasks, stats] = await Promise.all([listSources(), listTasks(), getStats()]);
  return { sources, tasks, stats };
}

type Listener = (payload: string) => void;

/** 首个订阅者加入时开始轮询，最后一个离开时停止；新订阅者立即收到最近一次结果。 */
export function overviewHub(load: () => Promise<KnowledgeOverview>, intervalMs: number, onError: (error: unknown) => void) {
  const listeners = new Set<Listener>();
  let latest: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 每次启动或停止轮询都加一；停止前已发出的读取返回后发现代数变化即退出，避免出现两条轮询。
  let generation = 0;

  function start() {
    const current = ++generation;
    const tick = async () => {
      let payload: string | null = null;
      try {
        payload = JSON.stringify(await load());
      } catch (error) {
        onError(error);
      }
      if (current !== generation) return;
      if (payload !== null && payload !== latest) {
        latest = payload;
        for (const listener of listeners) listener(payload);
      }
      timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      if (latest !== null) listener(latest);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(listener) || listeners.size) return;
        generation += 1;
        clearTimeout(timer);
        // 停止后缓存会过期，下次订阅重新读取。
        latest = null;
      };
    },
  };
}

export function knowledgeEventRoutes(app: FastifyInstance, options: OverviewEventsOptions = {}) {
  const { intervalMs = 2000, maxDurationMs = 5 * 60_000, heartbeatMs = 15_000 } = options;
  const hub = overviewHub(options.load ?? loadOverview, intervalMs, (error) => app.log.error(error, "Failed to load knowledge overview"));
  // 长连接不会自行结束，关闭服务前主动断开，否则 close() 要等到连接超时。
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => { for (const stream of streams) stream.end(); });

  app.get("/api/admin/knowledge/events", async (_request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    // 已由插件（如 CORS、鉴权钩子）设置在 reply 上的响应头需手动带到原始响应。
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) raw.setHeader(name, value);
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (text: string) => { if (!raw.destroyed && !raw.writableEnded) raw.write(text); };
    write("retry: 3000\n\n");

    const unsubscribe = hub.subscribe((payload) => write(`event: overview\ndata: ${payload}\n\n`));
    const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    const expire = setTimeout(() => raw.end(), maxDurationMs);
    streams.add(raw);
    raw.on("close", () => {
      streams.delete(raw);
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(expire);
    });
  });
}
