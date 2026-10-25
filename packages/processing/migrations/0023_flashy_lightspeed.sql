ALTER TABLE "chat_messages" ADD COLUMN "feedback_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "review_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "approved_revision" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "approved_at" timestamp with time zone;