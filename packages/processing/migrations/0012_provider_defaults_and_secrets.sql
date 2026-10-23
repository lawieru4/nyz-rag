CREATE TABLE "secret_settings" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_providers" ALTER COLUMN "chat_model" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "model_providers" ALTER COLUMN "credential_env" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "api_key_ciphertext" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "is_default_chat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "is_default_embedding" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "is_default_rerank" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_default_chat_idx" ON "model_providers" USING btree ("is_default_chat") WHERE "model_providers"."is_default_chat";--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_default_embedding_idx" ON "model_providers" USING btree ("is_default_embedding") WHERE "model_providers"."is_default_embedding";--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_default_rerank_idx" ON "model_providers" USING btree ("is_default_rerank") WHERE "model_providers"."is_default_rerank";--> statement-breakpoint
-- 原来的唯一默认供应商同时作为 Chat / Embedding / Rerank 的默认（Embedding、Rerank 只在已配置对应模型时设为默认）。
UPDATE "model_providers" SET "is_default_chat" = true, "is_default_embedding" = "embedding_model" <> '', "is_default_rerank" = "rerank_model" <> '' WHERE "is_default";--> statement-breakpoint
DROP INDEX "model_providers_single_default_idx";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "is_default";