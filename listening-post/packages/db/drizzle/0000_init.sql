CREATE TYPE "public"."category" AS ENUM('price', 'quality', 'customer service', 'reliability', 'usability', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."error_class" AS ENUM('transient', 'rate_limited', 'auth', 'blocked', 'quota', 'parse', 'bad_request');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('schedule', 'manual', 'reparse');--> statement-breakpoint
CREATE TYPE "public"."score_method" AS ENUM('rules', 'llm');--> statement-breakpoint
CREATE TYPE "public"."sentiment" AS ENUM('negative', 'neutral', 'positive');--> statement-breakpoint
CREATE TYPE "public"."site" AS ENUM('threadit', 'agora', 'ratewell', 'chirp');--> statement-breakpoint
CREATE TYPE "public"."strategy" AS ENUM('api', 'html', 'browser', 'unblocker');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" uuid,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"cursor" jsonb,
	"escalation_step" "strategy",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "costs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "costs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid,
	"client_id" uuid NOT NULL,
	"source_id" uuid,
	"provider" text NOT NULL,
	"units" numeric(14, 4) NOT NULL,
	"unit" text NOT NULL,
	"usd" numeric(12, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "eval_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"method" "score_method" NOT NULL,
	"sample_size" integer NOT NULL,
	"category_accuracy" real NOT NULL,
	"sentiment_accuracy" real NOT NULL,
	"f1_by_class" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_scores" (
	"item_id" bigint NOT NULL,
	"method" "score_method" NOT NULL,
	"category" "category",
	"sentiment" "sentiment",
	"confidence" real,
	"model" text,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_scores_item_id_method_pk" PRIMARY KEY("item_id","method")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_id" uuid NOT NULL,
	"site" "site" NOT NULL,
	"external_id" text NOT NULL,
	"author" text,
	"text" text NOT NULL,
	"text_hash" char(64) NOT NULL,
	"duplicate_of" bigint,
	"country" char(2),
	"published_at" timestamp with time zone,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_response_id" bigint
);
--> statement-breakpoint
CREATE TABLE "raw_responses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "raw_responses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"http_status" integer NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" "bytea",
	"sha256" char(64) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"pages" integer DEFAULT 0 NOT NULL,
	"items_found" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"error_class" "error_class",
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"site" "site" NOT NULL,
	"strategy" "strategy" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"budget_usd_month" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costs" ADD CONSTRAINT "costs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costs" ADD CONSTRAINT "costs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costs" ADD CONSTRAINT "costs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_scores" ADD CONSTRAINT "item_scores_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_raw_response_id_raw_responses_id_fk" FOREIGN KEY ("raw_response_id") REFERENCES "public"."raw_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_responses" ADD CONSTRAINT "raw_responses_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_uq" ON "alerts" USING btree ("source_id","kind") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "costs_client_created_idx" ON "costs" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "costs_source_created_idx" ON "costs" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "items_site_external_uq" ON "items" USING btree ("site","external_id");--> statement-breakpoint
CREATE INDEX "items_text_hash_idx" ON "items" USING btree ("text_hash");--> statement-breakpoint
CREATE INDEX "items_source_published_idx" ON "items" USING btree ("source_id","published_at");--> statement-breakpoint
CREATE INDEX "raw_run_idx" ON "raw_responses" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "raw_expires_idx" ON "raw_responses" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "raw_url_idx" ON "raw_responses" USING btree ("url","fetched_at");--> statement-breakpoint
CREATE INDEX "runs_source_created_idx" ON "runs" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sources_client_idx" ON "sources" USING btree ("client_id");