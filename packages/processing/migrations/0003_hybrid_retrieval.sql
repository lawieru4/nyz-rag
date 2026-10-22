CREATE TABLE "message_chunks" (
	"message_id" text NOT NULL,
	"position" integer NOT NULL,
	"chunk_id" text NOT NULL,
	"document_id" text NOT NULL,
	"citation" integer NOT NULL,
	"title" text NOT NULL,
	"section_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"excerpt" text NOT NULL,
	"score" double precision NOT NULL,
	"vector_score" double precision,
	"keyword_score" double precision,
	"rerank_score" double precision,
	CONSTRAINT "message_chunks_message_id_position_pk" PRIMARY KEY("message_id","position")
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "answer_mode" text DEFAULT 'extractive' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "knowledge_base_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "retrieval_ms" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "first_token_ms" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "total_ms" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "completion_tokens" integer;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "search_vector" "tsvector" DEFAULT ''::tsvector NOT NULL;--> statement-breakpoint
ALTER TABLE "message_sources" ADD COLUMN "repost_source" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "temperature" double precision DEFAULT 0.3 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "max_tokens" integer DEFAULT 1024 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_chunks_search_vector_idx" ON "document_chunks" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_answer_mode_check" CHECK ("chat_messages"."answer_mode" IN ('generated', 'extractive'));--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_temperature_check" CHECK ("model_providers"."temperature" BETWEEN 0 AND 2);--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_max_tokens_check" CHECK ("model_providers"."max_tokens" BETWEEN 1 AND 32768);