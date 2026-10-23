export type ChatLog = {
  id: string; sessionId?: string; ownerType: "user" | "visitor" | "none"; userEmail?: string; supersededAt?: string; question: string; answer: string; answerMode: "generated" | "extractive"; model?: string; retrievalMs?: number; firstTokenMs?: number; totalMs?: number; promptTokens?: number; completionTokens?: number;
  sources: Array<{ documentId: string; title: string; url: string; repostSource?: string }>;
  chunks: Array<{ chunkId: string; documentId: string; citation: number; title: string; sectionPath: string[]; excerpt: string; score: number; vectorScore?: number; keywordScore?: number; summaryScore?: number; rerankScore?: number }>;
  rating: "positive" | "negative" | null; createdAt: string;
};

export const chatLogOwner = (log: ChatLog) => log.ownerType === "user" ? log.userEmail ?? "注册用户" : log.ownerType === "visitor" ? "匿名访客" : "历史记录（无归属）";
export const ratingLabel = (rating: ChatLog["rating"]) => rating === "positive" ? "有帮助" : rating === "negative" ? "需改进" : "未评价";
