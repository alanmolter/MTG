CREATE TABLE `competitive_deck_cards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deck_id` int NOT NULL,
	`card_name` varchar(255) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`section` varchar(20) DEFAULT 'mainboard',
	CONSTRAINT `competitive_deck_cards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `competitive_decks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_id` varchar(128) NOT NULL,
	`source` varchar(50) NOT NULL DEFAULT 'moxfield',
	`name` varchar(255) NOT NULL,
	`format` varchar(50) NOT NULL,
	`archetype` varchar(100),
	`author` varchar(128),
	`likes` int DEFAULT 0,
	`views` int DEFAULT 0,
	`colors` varchar(10),
	`raw_json` text,
	`imported_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `competitive_decks_id` PRIMARY KEY(`id`),
	CONSTRAINT `competitive_decks_source_id_unique` UNIQUE(`source_id`)
);
--> statement-breakpoint
CREATE TABLE `training_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`status` enum('pending','running','completed','failed') NOT NULL DEFAULT 'pending',
	`job_type` varchar(50) NOT NULL DEFAULT 'embeddings',
	`total_decks` int DEFAULT 0,
	`total_cards` int DEFAULT 0,
	`embeddings_trained` int DEFAULT 0,
	`synergies_updated` int DEFAULT 0,
	`error_message` text,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`completed_at` timestamp,
	CONSTRAINT `training_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `competitive_deck_cards` ADD CONSTRAINT `competitive_deck_cards_deck_id_competitive_decks_id_fk` FOREIGN KEY (`deck_id`) REFERENCES `competitive_decks`(`id`) ON DELETE no action ON UPDATE no action;