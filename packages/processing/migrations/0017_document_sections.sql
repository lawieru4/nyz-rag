CREATE TABLE "document_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"section_index" integer NOT NULL,
	"section_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"part" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"token_estimate" integer NOT NULL,
	CONSTRAINT "document_sections_document_id_section_index_key" UNIQUE("document_id","section_index"),
	CONSTRAINT "document_sections_index_check" CHECK ("document_sections"."section_index" >= 0 AND "document_sections"."part" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "section_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "chunker_version" integer;--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "document_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_chunks_section_id_idx" ON "document_chunks" USING btree ("section_id");