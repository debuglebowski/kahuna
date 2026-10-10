CREATE INDEX "apollo_audit_log_created_idx" ON "apollo_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "clay_audit_log_created_idx" ON "clay_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "clay_job_pushed_idx" ON "clay_job" USING btree ("pushed_at");--> statement-breakpoint
CREATE INDEX "clay_notification_received_idx" ON "clay_notification" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "google_audit_log_created_idx" ON "google_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "linear_audit_log_created_idx" ON "linear_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "linear_webhook_event_received_idx" ON "linear_webhook_event" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "posthog_audit_log_created_idx" ON "posthog_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "posthog_webhook_event_received_idx" ON "posthog_webhook_event" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "slack_audit_log_created_idx" ON "slack_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "slack_event_received_idx" ON "slack_event" USING btree ("received_at");