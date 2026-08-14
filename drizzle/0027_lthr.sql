ALTER TABLE "activities" ADD COLUMN "lthr_sample_bpm" integer;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "lthr_sample_source" text;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "lthr_bpm" integer;--> statement-breakpoint
ALTER TABLE "athlete" ADD COLUMN "lthr_suggestion_dismissed_bpm" integer;