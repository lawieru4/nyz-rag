CREATE TABLE "admin_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"nickname" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_super" boolean DEFAULT false NOT NULL,
	"session_version" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_accounts_email_idx" ON "admin_accounts" USING btree ("email");
