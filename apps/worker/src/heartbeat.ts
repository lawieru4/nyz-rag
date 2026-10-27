// Worker 心跳：投递器每轮成功（数据库与 Redis 可用、队列消费者在运行）后写入当前时间，容器健康检查据此判断 Worker 是否存活。
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const heartbeatFile = process.env.NYZ_WORKER_HEARTBEAT_FILE || join(tmpdir(), "nyz-rag-worker.heartbeat");
/** 投递器每秒一轮；超过这个时长没有心跳视为不健康。 */
export const HEARTBEAT_MAX_AGE_MS = 30_000;

export const writeHeartbeat = () => writeFile(heartbeatFile, String(Date.now()));

export async function heartbeatAge(): Promise<number | null> {
  const written = Number.parseInt(await readFile(heartbeatFile, "utf8").catch(() => ""), 10);
  return Number.isFinite(written) ? Date.now() - written : null;
}
