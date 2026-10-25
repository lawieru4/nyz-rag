import type { DocumentSummary } from "@nyz-rag/types";

export const documentStatuses = { pending: "待处理", processing: "处理中", ready: "已就绪", failed: "失败" } as const;
export const embeddingStatuses = { pending: "待向量化", queued: "向量排队中", processing: "向量化中", ready: "已向量化", failed: "向量化失败" } as const;

export const documentBusy = (document: DocumentSummary) => document.embedding?.status === "queued" || document.embedding?.status === "processing" || document.processingStatus === "cleaning";

export function processingLabel(document: DocumentSummary) {
  switch (document.processingStatus) {
    case "chunked": return `已切片 ${document.chunkCount}`;
    case "cleaning": return "清洗中";
    case "duplicate": return "重复";
    case "failed": return "处理失败";
    default: return "待处理";
  }
}

type StatusTone = "success" | "muted" | "warning" | "danger";

/** 列表中状态标签的颜色：完成为成功色，进行中为等待色，失败为错误色。 */
export function processingTone(document: DocumentSummary): StatusTone {
  switch (document.processingStatus) {
    case "chunked": return "success";
    case "cleaning": return "warning";
    case "failed": return "danger";
    default: return "muted";
  }
}

export function embeddingTone(status: keyof typeof embeddingStatuses = "pending"): StatusTone {
  return status === "ready" ? "success" : status === "failed" ? "danger" : status === "pending" ? "muted" : "warning";
}
