CREATE TABLE "admin_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" text,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"resource_id" text,
	"status_code" integer NOT NULL,
	"result" text NOT NULL,
	"request_id" text NOT NULL,
	"ip" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_logs_result_check" CHECK ("admin_audit_logs"."result" IN ('success', 'denied', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_id_admin_accounts_id_fk" FOREIGN KEY ("admin_id") REFERENCES "admin_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_logs_created_at_idx" ON "admin_audit_logs" USING btree ("created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_admin_id_idx" ON "admin_audit_logs" USING btree ("admin_id","created_at" DESC NULLS LAST);