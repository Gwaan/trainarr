CREATE TABLE "activity_weather" (
	"activity_id" integer PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"source" text,
	"latitude_deg" real,
	"longitude_deg" real,
	"observed_at" timestamp with time zone,
	"temperature_c" real,
	"apparent_temperature_c" real,
	"precipitation_mm" real,
	"wind_speed_kmh" real,
	"wind_direction_deg" real,
	"relative_humidity_pct" real,
	"weather_code" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_weather" ADD CONSTRAINT "activity_weather_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_weather_status_last_attempt_idx" ON "activity_weather" USING btree ("status","last_attempt_at");