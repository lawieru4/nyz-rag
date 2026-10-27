import type { OperationBacklog } from "@nyz-rag/types";

/** 操作排队超过这个时长仍未开始，提示检查 Worker。 */
export const STALLED_QUEUE_MS = 5 * 60_000;

const waitText = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${Math.max(1, minutes)} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`;
};

/** 后台操作积压的展示：各项数量，以及排队过久时的提示（Worker 未运行或处理不过来）。 */
export function backlogStatus(backlog: OperationBacklog, now: number) {
  const waitedMs = backlog.oldestQueuedAt ? Math.max(0, now - Date.parse(backlog.oldestQueuedAt)) : 0;
  return {
    items: [
      { label: "排队", value: backlog.queued },
      { label: "执行中", value: backlog.running },
      { label: "等待重试", value: backlog.delayed },
      { label: "24 小时内失败", value: backlog.failedLastDay, danger: backlog.failedLastDay > 0 },
    ],
    stalled: waitedMs >= STALLED_QUEUE_MS ? `最早一项已排队 ${waitText(waitedMs)}，请确认 Worker 正在运行` : null,
  };
}
