-- 只保留 nyzdata 文章接口来源：删除网页站点来源（任务与文档随之级联删除）及没有原始文章 JSON 的文档。
-- 被删除文档名下的重复文档失去主文档，标记为处理失败，需在管理端「重新处理」后重新判定。
UPDATE "documents" SET "duplicate_of" = NULL, "processing_status" = 'failed', "processing_error" = '主文档已随网页站点来源删除，请重新处理', "updated_at" = now()
WHERE "duplicate_of" IN (
  SELECT "d"."id" FROM "documents" "d" JOIN "data_sources" "s" ON "s"."id" = "d"."source_id"
  WHERE "s"."kind" <> '文章 API' OR "d"."raw_json" IS NULL OR "d"."external_id" IS NULL
) AND "id" IN (
  SELECT "d"."id" FROM "documents" "d" JOIN "data_sources" "s" ON "s"."id" = "d"."source_id"
  WHERE "s"."kind" = '文章 API' AND "d"."raw_json" IS NOT NULL AND "d"."external_id" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "documents" WHERE "raw_json" IS NULL OR "external_id" IS NULL;--> statement-breakpoint
DELETE FROM "data_sources" WHERE "kind" <> '文章 API';--> statement-breakpoint
ALTER TABLE "data_sources" DROP CONSTRAINT "data_sources_kind_check";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "external_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "raw_json" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "raw_html";--> statement-breakpoint
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_kind_check" CHECK ("data_sources"."kind" = '文章 API');
