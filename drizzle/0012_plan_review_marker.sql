ALTER TABLE "plans" ADD COLUMN "reviewed_session_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "reviewed_at" timestamp with time zone;