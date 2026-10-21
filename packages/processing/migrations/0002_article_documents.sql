ALTER TABLE "data_sources" ADD COLUMN "sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "context" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "section_path" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "content_type" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "raw_json" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "markdown" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "author" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "parser_version" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE INDEX "documents_published_at_idx" ON "documents" USING btree ("published_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_external_id_key" UNIQUE("source_id","external_id");--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_content_type_check" CHECK ("document_chunks"."content_type" IN ('text', 'table'));