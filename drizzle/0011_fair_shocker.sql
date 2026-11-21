ALTER TABLE `refunds` ADD `issued_at` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `issued_by_user_id` integer REFERENCES users(id);