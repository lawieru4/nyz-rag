ALTER TABLE "chat_messages" ADD COLUMN "retrieval_query" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "rewrite_ms" integer;