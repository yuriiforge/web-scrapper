CREATE TABLE "rate_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
