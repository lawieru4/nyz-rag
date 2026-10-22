ALTER TABLE "documents" DROP CONSTRAINT "documents_source_id_url_key";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_processing_status_check";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "canonical_url" text;--> statement-breakpoint
UPDATE "documents" SET "canonical_url" = "url";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "canonical_url" SET NOT NULL;--> statement-breakpoint
-- 旧的 content_hash 按文章全部块计算且网页没有，改为正文指纹后由 Worker 启动时补齐。
UPDATE "documents" SET "content_hash" = NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "duplicate_of" text;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_duplicate_of_documents_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_content_hash_idx" ON "documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "documents_duplicate_of_idx" ON "documents" USING btree ("duplicate_of");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_canonical_url_key" UNIQUE("source_id","canonical_url");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_duplicate_of_check" CHECK ("documents"."duplicate_of" <> "documents"."id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_processing_status_check" CHECK ("documents"."processing_status" IN ('pending', 'cleaning', 'chunked', 'duplicate', 'failed'));