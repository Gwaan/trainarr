CREATE TABLE "push_notices" (
	"athlete_id" integer NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"athlete_id" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "push_daily_session" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "push_activity_analyzed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "push_suggestions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_notices" ADD CONSTRAINT "push_notices_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_notices_athlete_kind_dedupe_unique" ON "push_notices" USING btree ("athlete_id","kind","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_unique" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_athlete_id_idx" ON "push_subscriptions" USING btree ("athlete_id");