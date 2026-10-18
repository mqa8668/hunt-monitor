CREATE EXTENSION IF NOT EXISTS ltree;
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"path" "ltree" NOT NULL,
	"attribute_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_min_amount" bigint,
	"price_max_amount" bigint
);
--> statement-breakpoint
CREATE TABLE "catalog_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_key_version_pk" PRIMARY KEY("key","version")
);
--> statement-breakpoint
CREATE TABLE "enrichment" (
	"post_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"intent" text,
	"price_amount" double precision,
	"price_raw" text,
	"price_qualifier" text,
	"price_max_amount" double precision,
	"price_confidence" real,
	"condition" text,
	"category_id" uuid,
	"item_id" uuid,
	"confidence" double precision,
	"engine" text DEFAULT 'rule' NOT NULL,
	"model" text,
	"prompt_version" text,
	"tokens" integer,
	"text_hash" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attributes_version" integer,
	"price_suspect" boolean DEFAULT false NOT NULL,
	"display_title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_condition_check" CHECK ("enrichment"."condition" IS NULL OR "enrichment"."condition" IN ('new', 'like_new', 'used', 'broken', 'unknown')),
	CONSTRAINT "enrichment_price_qualifier_check" CHECK ("enrichment"."price_qualifier" IS NULL OR "enrichment"."price_qualifier" IN ('exact','floor','ceiling','approx','range')),
	CONSTRAINT "enrichment_intent_check" CHECK ("enrichment"."intent" IS NULL OR "enrichment"."intent" IN ('sell','buy','other'))
);
--> statement-breakpoint
CREATE TABLE "match" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"watch_id" uuid NOT NULL,
	"score" double precision NOT NULL,
	"matched_terms" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notify_enqueued_at" timestamp with time zone,
	CONSTRAINT "match_post_watch_unique" UNIQUE("post_id","watch_id")
);
--> statement-breakpoint
CREATE TABLE "metric_rollup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"dims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "metric_rollup_bucket_check" CHECK ("metric_rollup"."bucket" IN ('hour','day'))
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid,
	"notifier_id" uuid,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"sending_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_status_check" CHECK ("notification"."status" IN ('pending','sending','sent','merged','suppressed','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "notifier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "notifier_kind_check" CHECK ("notifier"."kind" IN ('stdout','webhook','telegram'))
);
--> statement-breakpoint
CREATE TABLE "poll_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"items_seen" integer,
	"items_new" integer,
	"error" text,
	CONSTRAINT "poll_run_outcome_check" CHECK ("poll_run"."outcome" IS NULL OR "poll_run"."outcome" IN ('ok','partial','error','skipped'))
);
--> statement-breakpoint
CREATE TABLE "post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"platform_post_id" text NOT NULL,
	"url" text NOT NULL,
	"author_name" text,
	"author_id" text,
	"title" text,
	"text" text DEFAULT '' NOT NULL,
	"text_normalized" text DEFAULT '' NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	"capture" text,
	"enrich_state" text DEFAULT 'pending' NOT NULL,
	"match_state" text DEFAULT 'pending' NOT NULL,
	"pipeline_version" integer DEFAULT 0 NOT NULL,
	"pipeline_attempts" integer DEFAULT 0 NOT NULL,
	"pipeline_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pipeline_reconciled_at" timestamp with time zone,
	"effective_at" timestamp with time zone GENERATED ALWAYS AS (coalesce(posted_at, first_seen_at)) STORED,
	CONSTRAINT "post_source_platform_post_unique" UNIQUE("source_id","platform_post_id"),
	CONSTRAINT "post_enrich_state_check" CHECK ("post"."enrich_state" IN ('pending','done','failed')),
	CONSTRAINT "post_match_state_check" CHECK ("post"."match_state" IN ('pending','done','failed')),
	CONSTRAINT "post_capture_check" CHECK ("post"."capture" IS NULL OR "post"."capture" IN ('api','feed','push'))
);
--> statement-breakpoint
CREATE TABLE "post_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"engagement" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"platform_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor" text,
	"last_ingest_at" timestamp with time zone,
	"last_health_at" timestamp with time zone,
	"watchdog_alert_at" timestamp with time zone,
	"expected_interval_sec" integer,
	"last_ok_poll_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_status_check" CHECK ("source"."status" IN ('active','paused','paused_by_health'))
);
--> statement-breakpoint
CREATE TABLE "watch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"include" text[] DEFAULT '{}' NOT NULL,
	"include_all" text[] DEFAULT '{}' NOT NULL,
	"exclude" text[] DEFAULT '{}' NOT NULL,
	"regex" text,
	"category_ids" uuid[] DEFAULT '{}' NOT NULL,
	"item_ids" uuid[] DEFAULT '{}' NOT NULL,
	"price_min" double precision,
	"price_max" double precision,
	"attribute_filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intents" text[] DEFAULT '{}' NOT NULL,
	"source_ids" uuid[] DEFAULT '{}' NOT NULL,
	"notifier_ids" uuid[] DEFAULT '{}' NOT NULL,
	"quiet_hours" jsonb,
	"muted_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment" ADD CONSTRAINT "enrichment_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment" ADD CONSTRAINT "enrichment_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment" ADD CONSTRAINT "enrichment_item_id_catalog_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_watch_id_watch_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_match_id_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."match"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_notifier_id_notifier_id_fk" FOREIGN KEY ("notifier_id") REFERENCES "public"."notifier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_run" ADD CONSTRAINT "poll_run_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revision" ADD CONSTRAINT "post_revision_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_path_unique" ON "category" USING btree ("path");--> statement-breakpoint
CREATE INDEX "category_path_idx" ON "category" USING gist ("path");--> statement-breakpoint
CREATE INDEX "enrichment_filter" ON "enrichment" USING btree ("intent","category_id","item_id","price_amount");--> statement-breakpoint
CREATE INDEX "enrichment_attributes_gin" ON "enrichment" USING gin ("attributes" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "match_watch_id_created_at_idx" ON "match" USING btree ("watch_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "match_created_at_id_idx" ON "match" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "metric_rollup_bucket_ts_dims_key" ON "metric_rollup" USING btree ("bucket","ts","dims");--> statement-breakpoint
CREATE INDEX "metric_rollup_metric_ts_idx" ON "metric_rollup" USING btree ("bucket",("dims"->>'metric'),"ts");--> statement-breakpoint
CREATE INDEX "notification_channel_idx" ON "notification" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "notification_status_next_attempt_idx" ON "notification" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_created_at_id_idx" ON "notification" USING btree ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "notification_match_notifier_unique" ON "notification" USING btree ("match_id","notifier_id") WHERE "notification"."match_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_match_no_notifier_unique" ON "notification" USING btree ("match_id") WHERE "notification"."match_id" is not null and "notification"."notifier_id" is null;--> statement-breakpoint
CREATE INDEX "poll_run_source_started_idx" ON "poll_run" USING btree ("source_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_source_id_idx" ON "post" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "post_source_fingerprint_idx" ON "post" USING btree ("source_id","fingerprint");--> statement-breakpoint
CREATE INDEX "post_first_seen_at_idx" ON "post" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "post_pipeline_pending_idx" ON "post" USING btree ("pipeline_updated_at") WHERE "post"."enrich_state" = 'pending' OR "post"."match_state" = 'pending';--> statement-breakpoint
CREATE INDEX "post_pipeline_failed_idx" ON "post" USING btree ("id") WHERE "post"."enrich_state" = 'failed' OR "post"."match_state" = 'failed';--> statement-breakpoint
CREATE INDEX "post_effective_at_id" ON "post" USING btree ("effective_at" DESC NULLS LAST,"id" DESC NULLS LAST);