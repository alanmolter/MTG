CREATE TABLE `card_synergies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`card1_id` int NOT NULL,
	`card2_id` int NOT NULL,
	`weight` int NOT NULL DEFAULT 0,
	`co_occurrence_rate` int NOT NULL DEFAULT 0,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `card_synergies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`scryfall_id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`type` text,
	`colors` varchar(10),
	`cmc` int,
	`rarity` varchar(20),
	`image_url` text,
	`power` varchar(10),
	`toughness` varchar(10),
	`text` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cards_id` PRIMARY KEY(`id`),
	CONSTRAINT `cards_scryfall_id_unique` UNIQUE(`scryfall_id`)
);
--> statement-breakpoint
CREATE TABLE `deck_cards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deck_id` int NOT NULL,
	`card_id` int NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	CONSTRAINT `deck_cards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `decks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`format` varchar(50) NOT NULL,
	`archetype` varchar(100),
	`description` text,
	`is_public` int DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `decks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `embeddings_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`card_id` int NOT NULL,
	`vector_json` text NOT NULL,
	`model_version` varchar(50) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `embeddings_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `embeddings_cache_card_id_unique` UNIQUE(`card_id`)
);
--> statement-breakpoint
CREATE TABLE `meta_stats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`card_id` int NOT NULL,
	`format` varchar(50) NOT NULL,
	`archetype` varchar(100),
	`play_rate` int NOT NULL DEFAULT 0,
	`win_rate` int NOT NULL DEFAULT 0,
	`frequency` int NOT NULL DEFAULT 0,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `meta_stats_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `card_synergies` ADD CONSTRAINT `card_synergies_card1_id_cards_id_fk` FOREIGN KEY (`card1_id`) REFERENCES `cards`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `card_synergies` ADD CONSTRAINT `card_synergies_card2_id_cards_id_fk` FOREIGN KEY (`card2_id`) REFERENCES `cards`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deck_cards` ADD CONSTRAINT `deck_cards_deck_id_decks_id_fk` FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deck_cards` ADD CONSTRAINT `deck_cards_card_id_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `decks` ADD CONSTRAINT `decks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `embeddings_cache` ADD CONSTRAINT `embeddings_cache_card_id_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meta_stats` ADD CONSTRAINT `meta_stats_card_id_cards_id_fk` FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON DELETE no action ON UPDATE no action;