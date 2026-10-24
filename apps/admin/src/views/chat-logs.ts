import type { ChatLogRecord } from "@nyz-rag/types";

export type ChatLog = ChatLogRecord;

export const chatLogOwner = (log: ChatLog) => log.ownerType === "user" ? log.userEmail ?? "注册用户" : log.ownerType === "visitor" ? "匿名访客" : "历史记录（无归属）";
export const ratingLabel = (rating: ChatLog["rating"]) => rating === "positive" ? "有帮助" : rating === "negative" ? "需改进" : "未评价";
