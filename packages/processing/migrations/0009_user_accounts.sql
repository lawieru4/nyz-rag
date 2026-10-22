CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"session_version" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "visitor_hash" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "visitor_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_user_id_idx" ON "chat_messages" USING btree ("user_id") WHERE "chat_messages"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_messages_visitor_hash_idx" ON "chat_messages" USING btree ("visitor_hash") WHERE "chat_messages"."visitor_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_sessions_user_id_idx" ON "chat_sessions" USING btree ("user_id","updated_at" DESC NULLS LAST) WHERE "chat_sessions"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_sessions_visitor_hash_idx" ON "chat_sessions" USING btree ("visitor_hash","updated_at" DESC NULLS LAST) WHERE "chat_sessions"."visitor_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_single_owner_check" CHECK ("chat_messages"."user_id" IS NULL OR "chat_messages"."visitor_hash" IS NULL);--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_single_owner_check" CHECK ("chat_sessions"."user_id" IS NULL OR "chat_sessions"."visitor_hash" IS NULL);