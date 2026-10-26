ALTER TABLE "chat_messages" ADD COLUMN "rewrite_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "rewrite_completion_tokens" integer;