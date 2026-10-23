ALTER TABLE "crawl_tasks" ADD COLUMN "processed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_tasks" ADD COLUMN "failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_tasks" ADD COLUMN "article_limit" integer;