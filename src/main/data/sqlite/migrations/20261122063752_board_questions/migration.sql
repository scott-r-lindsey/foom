-- Rebuild the parent and its dependent receipts with foreign keys enabled.
CREATE TABLE `__new_board_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`thread` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_board_posts_thread_board_threads_id_fk` FOREIGN KEY (`thread`) REFERENCES `board_threads`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "board_post_kind" CHECK("kind" IN ('request','answer','decision-needed','fyi','link','question')),
	CONSTRAINT "board_post_json" CHECK(json_valid("data"))
) STRICT;
INSERT INTO `__new_board_posts` (`id`, `thread`, `kind`, `data`)
    SELECT `id`, `thread`, `kind`, `data` FROM `board_posts` ORDER BY rowid;
CREATE UNIQUE INDEX `__new_board_post_identity` ON `__new_board_posts` (`id`,`thread`);
CREATE TABLE `__new_board_receipts` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`hash` text NOT NULL,
	`thread` text NOT NULL,
	`post` text,
	CONSTRAINT `board_receipts_pk` PRIMARY KEY(`scope`, `key`),
	CONSTRAINT `fk_board_receipts_thread_board_threads_id_fk` FOREIGN KEY (`thread`) REFERENCES `board_threads`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_board_receipts_post_thread_board_posts_id_thread_fk` FOREIGN KEY (`post`,`thread`) REFERENCES `__new_board_posts`(`id`,`thread`) ON DELETE RESTRICT
) STRICT;
INSERT INTO `__new_board_receipts` (`scope`, `key`, `hash`, `thread`, `post`)
    SELECT `scope`, `key`, `hash`, `thread`, `post` FROM `board_receipts`;

DROP TABLE `board_receipts`;
DROP TABLE `board_posts`;
ALTER TABLE `__new_board_posts` RENAME TO `board_posts`;
ALTER TABLE `__new_board_receipts` RENAME TO `board_receipts`;
CREATE UNIQUE INDEX `board_post_identity` ON `board_posts` (`id`,`thread`);
DROP INDEX `__new_board_post_identity`;
CREATE INDEX `board_posts_thread` ON `board_posts` (`thread`);
CREATE INDEX `board_receipts_thread` ON `board_receipts` (`thread`);
CREATE INDEX `board_receipts_post` ON `board_receipts` (`post`,`thread`);

CREATE TRIGGER `board_posts_insert` AFTER INSERT ON `board_posts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_posts'); END;

CREATE TRIGGER `board_posts_update` AFTER UPDATE ON `board_posts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_posts'); END;

CREATE TRIGGER `board_posts_delete` AFTER DELETE ON `board_posts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_posts'); END;

CREATE TRIGGER `board_receipts_insert` AFTER INSERT ON `board_receipts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_receipts'); END;

CREATE TRIGGER `board_receipts_update` AFTER UPDATE ON `board_receipts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_receipts'); END;

CREATE TRIGGER `board_receipts_delete` AFTER DELETE ON `board_receipts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_receipts'); END;
