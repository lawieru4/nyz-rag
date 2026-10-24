CREATE TABLE "operations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "operations_kind_check" CHECK ("operations"."kind" IN ('sync-source', 'reprocess-document', 'embed-document')),
	CONSTRAINT "operations_target_check" CHECK (("operations"."kind" = 'sync-source') = ("operations"."target_type" = 'source')),
	CONSTRAINT "operations_status_check" CHECK ("operations"."status" IN ('pending', 'dispatched', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "crawl_tasks" ADD COLUMN "operation_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "operations_active_target_idx" ON "operations" USING btree ("target_type","target_id") WHERE "operations"."status" IN ('pending', 'dispatched', 'running');--> statement-breakpoint
CREATE INDEX "operations_active_status_idx" ON "operations" USING btree ("status","run_after") WHERE "operations"."status" IN ('pending', 'dispatched', 'running');--> statement-breakpoint
CREATE INDEX "operations_finished_at_idx" ON "operations" USING btree ("finished_at") WHERE "operations"."finished_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_tasks" ADD CONSTRAINT "crawl_tasks_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawl_tasks_operation_id_idx" ON "crawl_tasks" USING btree ("operation_id");--> statement-breakpoint
-- 升级前仍在进行的工作转为操作，由新的投递器执行（旧队列中的 job 由 Worker 启动时删除）：
-- 活动的同步任务、待重新处理的文档、向量排队中/向量化中的已切片文档（同一文档已有重新处理时由它向量化）。
WITH "created" AS (
	INSERT INTO "operations" ("id", "kind", "target_type", "target_id")
	SELECT gen_random_uuid()::text, 'sync-source', 'source', "source_id" FROM "crawl_tasks" WHERE "status" IN ('等待中', '运行中')
	RETURNING "id", "target_id"
)
UPDATE "crawl_tasks" SET "operation_id" = "created"."id", "status" = '等待中'
FROM "created" WHERE "crawl_tasks"."source_id" = "created"."target_id" AND "crawl_tasks"."status" IN ('等待中', '运行中');--> statement-breakpoint
INSERT INTO "operations" ("id", "kind", "target_type", "target_id")
SELECT gen_random_uuid()::text, 'reprocess-document', 'document', "id" FROM "documents" WHERE "processing_status" = 'pending';--> statement-breakpoint
WITH "created" AS (
	INSERT INTO "operations" ("id", "kind", "target_type", "target_id")
	SELECT gen_random_uuid()::text, 'embed-document', 'document', "id" FROM "documents"
	WHERE "embedding_status" IN ('queued', 'processing') AND "processing_status" = 'chunked'
	ON CONFLICT DO NOTHING
	RETURNING "target_id"
)
UPDATE "documents" SET "embedding_status" = 'queued' FROM "created" WHERE "documents"."id" = "created"."target_id";
