ALTER TABLE "activities" ADD COLUMN "elevation_loss_m" real;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "elevation_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "vo2max_elevation_correction" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "vo2max_ascent_coef_m" real DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "vo2max_descent_coef_m" real DEFAULT -1 NOT NULL;