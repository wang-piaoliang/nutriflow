CREATE TABLE `sync_docs` (
	`user_email` text NOT NULL,
	`doc_key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_email`, `doc_key`)
);
