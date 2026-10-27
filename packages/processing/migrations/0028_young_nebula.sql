ALTER TABLE "chat_messages" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_fallback_reason_check" CHECK ("chat_messages"."fallback_reason" IS NULL OR ("chat_messages"."answer_mode" = 'extractive'
    AND "chat_messages"."fallback_reason" IN ('no_chat_model', 'no_context', 'model_error', 'citation_rejected', 'empty_answer')));