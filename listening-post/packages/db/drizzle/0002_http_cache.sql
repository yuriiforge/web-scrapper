CREATE TABLE "http_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"etag" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
