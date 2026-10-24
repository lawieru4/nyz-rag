-- 升级前同一来源可能残留多个等待中/运行中的任务：只保留最新一个，其余标为失败，再建唯一索引。
UPDATE "crawl_tasks" SET "status" = '失败', "error" = '同一来源有更新的同步任务，此任务已取消'
WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (PARTITION BY "source_id" ORDER BY "created_at" DESC, "id" DESC) AS "rank"
		FROM "crawl_tasks" WHERE "status" IN ('等待中', '运行中')
	) AS "active" WHERE "rank" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_tasks_active_source_idx" ON "crawl_tasks" USING btree ("source_id") WHERE "crawl_tasks"."status" IN ('等待中', '运行中');
