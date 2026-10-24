// 文档清洗切片与重复判定：在调用方事务内执行（Worker 的采集、重新处理任务调用）。
import type { ChunkerVersion } from "./chunking.js";
import type { Executor } from "./db.js";
import { isDedupCandidate } from "./dedup.js";
import { prepareDocument } from "./prepare.js";
import {
  findPrimaryDocument, getProcessingInput, listDuplicateDocuments, lockContentHashes, lockDocument, markDocumentDuplicate, replaceDocumentChunks, setDuplicateOf,
} from "./repository.js";

export interface ProcessDocumentResult {
  /** 正文与已有文档相同时为主文档 ID，本文档不切片。 */
  duplicateOf: string | null;
  chunks: number;
  /** 需要向量化的文档：本文档（不是重复文档时）以及因本文档内容变化而接替为主文档的重复文档。 */
  embed: string[];
}

/**
 * 清洗并重新切片；旧切片与向量一并替换。文章来源从原始 JSON 重新解析。
 * 正文与已有主文档（最早入库的同指纹文档）相同时只保存清洗结果并标记为重复，不切片。
 * 本文档原有的重复文档：正文仍相同的跟随本文档（或本文档的新主文档），其余重新判定，最早入库的一篇接替为主文档。
 * chunkerVersion 只在评估建立实验索引时指定，默认为 CHUNKER_VERSION。
 */
export async function processDocument(tx: Executor, documentId: string, chunkerVersion?: ChunkerVersion): Promise<ProcessDocumentResult> {
  const current = await lockDocument(tx, documentId);
  if (!current) throw new Error("document not found");
  const input = await getProcessingInput(tx, documentId);
  if (!input) throw new Error("document not found");
  const { update, chunks, sections } = prepareDocument(documentId, input, chunkerVersion);
  const hash = update.contentHash!;
  const candidate = isDedupCandidate(update.content);
  // 同时锁住旧指纹：其他事务不能在本文档内容变化期间把新文档挂到它名下。
  await lockContentHashes(tx, [hash, current.contentHash]);
  const primary = candidate ? await findPrimaryDocument(tx, hash, documentId) : null;
  if (primary) await markDocumentDuplicate(tx, documentId, primary, update);
  else await replaceDocumentChunks(tx, documentId, update, chunks, sections);

  const dependents = await listDuplicateDocuments(tx, documentId);
  const follow = dependents.filter((row) => candidate && row.contentHash === hash).map((row) => row.id);
  const rehome = dependents.filter((row) => !follow.includes(row.id)).map((row) => row.id);
  if (primary) await setDuplicateOf(tx, follow, primary);
  await setDuplicateOf(tx, rehome, null);
  const embed = primary ? [] : [documentId];
  // 按入库先后重新判定：第一篇成为主文档，其余正文相同的成为它的重复文档。
  for (const id of rehome) embed.push(...(await processDocument(tx, id, chunkerVersion)).embed);
  return { duplicateOf: primary, chunks: primary ? 0 : chunks.length, embed };
}
