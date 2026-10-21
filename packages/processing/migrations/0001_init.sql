CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"rating" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_rating_check" CHECK ("chat_messages"."rating" IN ('positive', 'negative'))
);
--> statement-breakpoint
CREATE TABLE "crawl_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"source_name" text NOT NULL,
	"status" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crawl_tasks_status_check" CHECK ("crawl_tasks"."status" IN ('等待中', '运行中', '已完成', '失败')),
	CONSTRAINT "crawl_tasks_progress_check" CHECK ("crawl_tasks"."progress" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"kind" text NOT NULL,
	"frequency" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone,
	CONSTRAINT "data_sources_kind_check" CHECK ("data_sources"."kind" IN ('文章 API', '网页站点')),
	CONSTRAINT "data_sources_status_check" CHECK ("data_sources"."status" IN ('运行中', '已暂停'))
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_estimate" integer NOT NULL,
	"provider_id" text,
	"model" text,
	"dimensions" integer,
	"embedding" vector,
	"embedded_at" timestamp with time zone,
	CONSTRAINT "document_chunks_document_id_chunk_index_key" UNIQUE("document_id","chunk_index"),
	CONSTRAINT "document_chunks_chunk_index_check" CHECK ("document_chunks"."chunk_index" >= 0),
	CONSTRAINT "document_chunks_embedding_check" CHECK (("document_chunks"."embedding" IS NULL) = ("document_chunks"."dimensions" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"raw_html" text,
	"status" text NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"processing_error" text,
	"processing_version" integer DEFAULT 0 NOT NULL,
	"embedding_status" text DEFAULT 'pending' NOT NULL,
	"embedding_provider_id" text,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"embedding_chunk_count" integer DEFAULT 0 NOT NULL,
	"embedding_error" text,
	"embedding_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_source_id_url_key" UNIQUE("source_id","url"),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" IN ('pending', 'processing', 'ready', 'failed')),
	CONSTRAINT "documents_processing_status_check" CHECK ("documents"."processing_status" IN ('pending', 'cleaning', 'chunked', 'failed')),
	CONSTRAINT "documents_embedding_status_check" CHECK ("documents"."embedding_status" IN ('pending', 'queued', 'processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"top_k" integer NOT NULL,
	"similarity_threshold" double precision NOT NULL,
	"rerank_enabled" boolean DEFAULT false NOT NULL,
	"max_context_length" integer NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_bases_top_k_check" CHECK ("knowledge_bases"."top_k" BETWEEN 1 AND 100),
	CONSTRAINT "knowledge_bases_similarity_threshold_check" CHECK ("knowledge_bases"."similarity_threshold" BETWEEN 0 AND 1),
	CONSTRAINT "knowledge_bases_max_context_length_check" CHECK ("knowledge_bases"."max_context_length" >= 256)
);
--> statement-breakpoint
CREATE TABLE "message_sources" (
	"message_id" text NOT NULL,
	"position" integer NOT NULL,
	"document_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "message_sources_message_id_position_pk" PRIMARY KEY("message_id","position")
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"chat_model" text NOT NULL,
	"embedding_model" text DEFAULT '' NOT NULL,
	"rerank_model" text DEFAULT '' NOT NULL,
	"credential_env" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_tasks" ADD CONSTRAINT "crawl_tasks_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_sources" ADD CONSTRAINT "message_sources_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_created_at_idx" ON "chat_messages" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "crawl_tasks_created_at_idx" ON "crawl_tasks" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_updated_at_idx" ON "documents" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_single_default_idx" ON "model_providers" USING btree ("is_default") WHERE "model_providers"."is_default";