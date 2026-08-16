CREATE TABLE "activity_best_segments" (
	"activity_id" integer NOT NULL,
	"target_m" numeric(9, 2) NOT NULL,
	"time_s" real NOT NULL,
	"pace_sec_per_km" real NOT NULL,
	CONSTRAINT "activity_best_segments_activity_id_target_m_pk" PRIMARY KEY("activity_id","target_m"),
	CONSTRAINT "activity_best_segments_target_m_known" CHECK ("activity_best_segments"."target_m" in (400.00, 1000.00, 1609.34, 5000.00, 10000.00, 21097.50))
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "best_segments_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_best_segments" ADD CONSTRAINT "activity_best_segments_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_best_segments_target_m_time_s_idx" ON "activity_best_segments" USING btree ("target_m","time_s");