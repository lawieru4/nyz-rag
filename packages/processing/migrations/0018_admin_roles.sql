CREATE TABLE "admin_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_accounts" ADD COLUMN "role_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_roles_name_idx" ON "admin_roles" USING btree ("name");--> statement-breakpoint
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_role_id_admin_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- 升级前的普通管理员没有角色（即没有任何权限）：为其创建一个角色，权限对齐升级前（新建来源、文章 token、模型配置修改原本就只限超级管理员；数据源的同步与暂停随「数据源·管理」一并收回，需要时由超级管理员勾选）。
WITH "role" AS (
	INSERT INTO "admin_roles" ("id", "name", "description", "permissions")
	SELECT gen_random_uuid()::text, '普通管理员', '升级时为已有的普通管理员自动创建',
		ARRAY['sources:view', 'documents:view', 'documents:manage', 'knowledge-bases:view', 'knowledge-bases:manage', 'chat-logs:view', 'users:view', 'users:manage', 'models:view']::text[]
	WHERE EXISTS (SELECT 1 FROM "admin_accounts" WHERE NOT "is_super")
	RETURNING "id"
)
UPDATE "admin_accounts" SET "role_id" = (SELECT "id" FROM "role") WHERE NOT "is_super";
