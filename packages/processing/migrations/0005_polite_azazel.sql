CREATE INDEX "document_chunks_embedding_384_hnsw_idx" ON "document_chunks" USING hnsw (("embedding"::vector(384)) vector_cosine_ops) WHERE "document_chunks"."dimensions" = 384;--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_512_hnsw_idx" ON "document_chunks" USING hnsw (("embedding"::vector(512)) vector_cosine_ops) WHERE "document_chunks"."dimensions" = 512;--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_768_hnsw_idx" ON "document_chunks" USING hnsw (("embedding"::vector(768)) vector_cosine_ops) WHERE "document_chunks"."dimensions" = 768;--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_1024_hnsw_idx" ON "document_chunks" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops) WHERE "document_chunks"."dimensions" = 1024;--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_1536_hnsw_idx" ON "document_chunks" USING hnsw (("embedding"::vector(1536)) vector_cosine_ops) WHERE "document_chunks"."dimensions" = 1536;--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_2000_hnsw_idx" ON "document_chunks" USING hnsw (("embedding"::vector(2000)) vector_cosine_ops) WHERE "document_chunks"."dimensions" = 2000;--> statement-breakpoint
CREATE INDEX "documents_category_idx" ON "documents" USING btree ("category");--> statement-breakpoint
CREATE INDEX "documents_tags_idx" ON "documents" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "documents_scenarios_idx" ON "documents" USING gin (("metadata"->'sourceMeta'->'scenarios'));