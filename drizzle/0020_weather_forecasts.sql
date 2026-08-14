CREATE TABLE "weather_forecast_runs" (
	"athlete_id" integer PRIMARY KEY NOT NULL,
	"reading_day" date NOT NULL,
	"status" text NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"latitude_deg" real,
	"longitude_deg" real,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weather_forecasts" (
	"athlete_id" integer NOT NULL,
	"forecast_date" date NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"weather_code" integer,
	"temperature_max_c" real,
	"temperature_min_c" real,
	"apparent_temperature_max_c" real,
	"apparent_temperature_min_c" real,
	"precipitation_sum_mm" real,
	"precipitation_probability_max_pct" real,
	"wind_speed_max_kmh" real,
	CONSTRAINT "weather_forecasts_athlete_id_forecast_date_pk" PRIMARY KEY("athlete_id","forecast_date")
);
--> statement-breakpoint
ALTER TABLE "weather_forecast_runs" ADD CONSTRAINT "weather_forecast_runs_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weather_forecasts" ADD CONSTRAINT "weather_forecasts_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;