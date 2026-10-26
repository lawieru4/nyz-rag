import type { ModelCapability } from "@nyz-rag/types";

// 按模型名称粗分候选，分不出时给出全部，仍可手动输入任意模型名。
const chatModelPattern = { pattern: /./, exclude: /embed|bge|m3e|bce|rerank/i };
export const capabilities: Array<{ id: ModelCapability; label: string; description: string; placeholder: string; pattern: RegExp; exclude?: RegExp; generative?: true; defaultTemperature?: number; defaultMaxTokens?: number }> = [
  { id: "chat", label: "Chat", description: "问答生成；未配置或调用失败时摘录原文片段", placeholder: "例如 deepseek-ai/DeepSeek-V3", ...chatModelPattern, generative: true },
  { id: "embedding", label: "Embedding", description: "文档向量化与向量检索；配置后新文档切片完成即自动向量化", placeholder: "例如 BAAI/bge-m3", pattern: /embed|bge|m3e|bce/i, exclude: /rerank/i },
  { id: "rerank", label: "Rerank", description: "重排序；知识库开启重排序时使用", placeholder: "例如 BAAI/bge-reranker-v2-m3", pattern: /rerank/i },
  { id: "rewrite", label: "检索问题改写", description: "追问时结合对话历史把问题改写为独立问题再检索；未配置时用 Chat 模型。改写耗时计入首 Token 延迟，建议选用响应快、不带推理的模型", placeholder: "例如 Qwen/Qwen2.5-7B-Instruct", ...chatModelPattern, generative: true, defaultTemperature: 0, defaultMaxTokens: 256 },
  { id: "review", label: "审核", description: "评估集题目审核等离线任务；建议选用与 Chat 不同的模型，避免同一模型审核自己生成的内容", placeholder: "例如 Qwen/Qwen3-235B-A22B", ...chatModelPattern, generative: true, defaultTemperature: 0 },
];

export type Capability = (typeof capabilities)[number];
