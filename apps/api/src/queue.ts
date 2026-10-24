import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { DocumentSummary } from "@nyz-rag/types";

export interface DocumentQueue {
  hasDocumentJob(document: Pick<DocumentSummary, "id" | "sourceId">): Promise<boolean>;
  enqueueDocument(name: "reprocess-document" | "embed-document", documentId: string): Promise<void>;
  enqueueSource(sourceId: string, taskId: string): Promise<void>;
  close(): Promise<void>;
}

export const documentJobId = (id: string) => `document-${id}`;
export const sourceJobId = (taskId: string) => `sync-${taskId}`;
const jobOptions = (jobId: string) => ({ jobId, removeOnComplete: true, removeOnFail: true });

export function documentQueueService(queue: Pick<Queue, "getJob" | "getJobs" | "add">, close: () => Promise<void>): DocumentQueue {
  return {
    async hasDocumentJob(document) {
      if (await queue.getJob(documentJobId(document.id))) return true;
      const activeJobs = await queue.getJobs(["active"]);
      return activeJobs.some((job) => job.name === "sync-source" && job.data.sourceId === document.sourceId);
    },
    async enqueueDocument(name, documentId) {
      await queue.add(name, { documentId }, jobOptions(documentJobId(documentId)));
    },
    async enqueueSource(sourceId, taskId) {
      // Key by task, not source: concurrent requests must not leave a task without a job.
      await queue.add("sync-source", { sourceId, taskId }, jobOptions(sourceJobId(taskId)));
    },
    close,
  };
}

export function createDocumentQueue(): DocumentQueue {
  const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  const queue = new Queue(process.env.DOCUMENT_QUEUE_NAME ?? "document-processing", { connection });
  return documentQueueService(queue, async () => {
    try { await queue.close(); }
    finally { await connection.quit(); }
  });
}
