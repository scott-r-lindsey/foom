CREATE TABLE `legacy_window_size` (
	`id` integer PRIMARY KEY,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	CONSTRAINT "window_size_singleton" CHECK("id"=1),
	CONSTRAINT "window_size_positive" CHECK("width" BETWEEN 1 AND 9007199254740991 AND "height" BETWEEN 1 AND 9007199254740991)
) STRICT;
--> statement-breakpoint
CREATE TABLE `preview_records` (
	`id` text PRIMARY KEY NOT NULL,
	`window` text NOT NULL,
	`worktree` text,
	`worktreeSnapshot` text NOT NULL,
	`relativePath` text NOT NULL,
	`network` integer NOT NULL,
	CONSTRAINT `fk_preview_records_window_windows_id_fk` FOREIGN KEY (`window`) REFERENCES `windows`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_preview_records_worktree_worktrees_path_fk` FOREIGN KEY (`worktree`) REFERENCES `worktrees`(`path`) ON DELETE RESTRICT,
	CONSTRAINT "previews_network" CHECK("network"=0),
	CONSTRAINT "previews_id" CHECK(length("id")=32 AND "id" NOT GLOB '*[^a-f0-9]*')
) STRICT;
--> statement-breakpoint
CREATE TABLE `update_activity` (
	`period` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	CONSTRAINT "update_period" CHECK("period" IN ('d','w','m')),
	CONSTRAINT "update_date" CHECK(COALESCE(length("date")=10 AND "date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date("date",'+0 days')="date" AND ("period"!='w' OR strftime('%w',"date")='1') AND ("period"!='m' OR substr("date",9,2)='01'),0))
) STRICT;
--> statement-breakpoint
CREATE TABLE `windows` (
	`id` text PRIMARY KEY NOT NULL,
	`display` integer NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`maximized` integer NOT NULL,
	CONSTRAINT "windows_id" CHECK(length("id") BETWEEN 1 AND 64 AND "id" NOT GLOB '*[^a-zA-Z0-9-]*'),
	CONSTRAINT "windows_geometry" CHECK(abs("x") <= 100000 AND abs("y") <= 100000 AND "width" BETWEEN 1 AND 20000 AND "height" BETWEEN 1 AND 20000),
	CONSTRAINT "windows_maximized" CHECK("maximized" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `previews_window` ON `preview_records` (`window`);--> statement-breakpoint
CREATE INDEX `previews_worktree` ON `preview_records` (`worktree`);
CREATE TRIGGER `windows_insert` AFTER INSERT ON `windows` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('windows'); END;

CREATE TRIGGER `windows_update` AFTER UPDATE ON `windows` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('windows'); END;

CREATE TRIGGER `windows_delete` AFTER DELETE ON `windows` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('windows'); END;

CREATE TRIGGER `legacy_window_size_insert` AFTER INSERT ON `legacy_window_size` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('legacy_window_size'); END;

CREATE TRIGGER `legacy_window_size_update` AFTER UPDATE ON `legacy_window_size` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('legacy_window_size'); END;

CREATE TRIGGER `legacy_window_size_delete` AFTER DELETE ON `legacy_window_size` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('legacy_window_size'); END;

CREATE TRIGGER `update_activity_insert` AFTER INSERT ON `update_activity` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('update_activity'); END;

CREATE TRIGGER `update_activity_update` AFTER UPDATE ON `update_activity` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('update_activity'); END;

CREATE TRIGGER `update_activity_delete` AFTER DELETE ON `update_activity` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('update_activity'); END;

CREATE TRIGGER `preview_records_insert` AFTER INSERT ON `preview_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('preview_records'); END;

CREATE TRIGGER `preview_records_update` AFTER UPDATE ON `preview_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('preview_records'); END;

CREATE TRIGGER `preview_records_delete` AFTER DELETE ON `preview_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('preview_records'); END;
