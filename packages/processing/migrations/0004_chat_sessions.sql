CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"knowledge_base_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chat_sessions_updated_at_idx" ON "chat_sessions" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_session_id_idx" ON "chat_messages" USING btree ("session_id","created_at");