CREATE TABLE "model_settings" (
	"capability" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"temperature" double precision DEFAULT 0.3 NOT NULL,
	"max_tokens" integer DEFAULT 1024 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_settings_capability_check" CHECK ("model_settings"."capability" IN ('chat', 'embedding', 'rerank')),
	CONSTRAINT "model_settings_model_check" CHECK (btrim("model_settings"."model") <> ''),
	CONSTRAINT "model_settings_temperature_check" CHECK ("model_settings"."temperature" BETWEEN 0 AND 2),
	CONSTRAINT "model_settings_max_tokens_check" CHECK ("model_settings"."max_tokens" BETWEEN 1 AND 32768)
);
--> statement-breakpoint
ALTER TABLE "model_providers" DROP CONSTRAINT "model_providers_temperature_check";--> statement-breakpoint
ALTER TABLE "model_providers" DROP CONSTRAINT "model_providers_max_tokens_check";--> statement-breakpoint
DROP INDEX "model_providers_default_chat_idx";--> statement-breakpoint
DROP INDEX "model_providers_default_embedding_idx";--> statement-breakpoint
DROP INDEX "model_providers_default_rerank_idx";--> statement-breakpoint
ALTER TABLE "model_settings" ADD CONSTRAINT "model_settings_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- 原来各用途的默认供应商及其模型转为业务模型配置。
INSERT INTO "model_settings" ("capability", "provider_id", "model", "temperature", "max_tokens")
SELECT 'chat', "id", "chat_model", "temperature", "max_tokens" FROM "model_providers" WHERE "is_default_chat" AND btrim("chat_model") <> ''
UNION ALL SELECT 'embedding', "id", "embedding_model", 0.3, 1024 FROM "model_providers" WHERE "is_default_embedding" AND btrim("embedding_model") <> ''
UNION ALL SELECT 'rerank', "id", "rerank_model", 0.3, 1024 FROM "model_providers" WHERE "is_default_rerank" AND btrim("rerank_model") <> '';--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "chat_model";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "embedding_model";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "rerank_model";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "temperature";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "max_tokens";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "is_default_chat";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "is_default_embedding";--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "is_default_rerank";