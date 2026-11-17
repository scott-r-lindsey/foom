CREATE TABLE `_changes` (
	`revision` integer PRIMARY KEY AUTOINCREMENT,
	`table_name` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `hosts` (
	`alias` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "hosts_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `_imports` (
	`name` text PRIMARY KEY NOT NULL,
	`report` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `owned_worktrees` (
	`path` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`state` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_owned_worktrees_path_worktrees_path_fk` FOREIGN KEY (`path`) REFERENCES `worktrees`(`path`) ON DELETE RESTRICT,
	CONSTRAINT `fk_owned_worktrees_owner_sessions_id_fk` FOREIGN KEY (`owner`) REFERENCES `sessions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "owned_worktrees_state" CHECK("state" IN ('unused', 'used')),
	CONSTRAINT "owned_worktrees_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `pending_removals` (
	`path` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_pending_removals_repository_repositories_path_fk` FOREIGN KEY (`repository`) REFERENCES `repositories`(`path`) ON DELETE RESTRICT,
	CONSTRAINT "pending_removals_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `quarantine` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source` text NOT NULL,
	`position` integer NOT NULL,
	`reason` text NOT NULL,
	CONSTRAINT "quarantine_reason" CHECK("reason" IN ('invalid', 'relationship', 'conflict'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `repositories` (
	`path` text PRIMARY KEY NOT NULL,
	`registration` text UNIQUE
) STRICT;
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text,
	`repository` text,
	`worktree` text,
	`parent` text,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_sessions_host_hosts_alias_fk` FOREIGN KEY (`host`) REFERENCES `hosts`(`alias`) ON DELETE RESTRICT,
	CONSTRAINT `fk_sessions_repository_repositories_path_fk` FOREIGN KEY (`repository`) REFERENCES `repositories`(`path`) ON DELETE RESTRICT,
	CONSTRAINT `fk_sessions_worktree_worktrees_path_fk` FOREIGN KEY (`worktree`) REFERENCES `worktrees`(`path`) ON DELETE RESTRICT,
	CONSTRAINT `fk_sessions_parent_sessions_id_fk` FOREIGN KEY (`parent`) REFERENCES `sessions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "sessions_kind" CHECK("kind" IN ('local', 'remote', 'home', 'config')),
	CONSTRAINT "sessions_placement" CHECK(("kind" = 'remote') = ("host" IS NOT NULL)),
	CONSTRAINT "sessions_local_repository" CHECK("kind" != 'local' OR "repository" IS NOT NULL),
	CONSTRAINT "sessions_parent_self" CHECK("parent" IS NULL OR "parent" != "id"),
	CONSTRAINT "sessions_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `worktree_parents` (
	`path` text PRIMARY KEY NOT NULL,
	`identity` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `worktrees` (
	`path` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_worktrees_repository_repositories_path_fk` FOREIGN KEY (`repository`) REFERENCES `repositories`(`path`) ON DELETE RESTRICT,
	CONSTRAINT "worktrees_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE INDEX `owned_worktrees_owner` ON `owned_worktrees` (`owner`);--> statement-breakpoint
CREATE INDEX `pending_removals_repository` ON `pending_removals` (`repository`);--> statement-breakpoint
CREATE INDEX `sessions_host` ON `sessions` (`host`);--> statement-breakpoint
CREATE INDEX `sessions_repository` ON `sessions` (`repository`);--> statement-breakpoint
CREATE INDEX `sessions_worktree` ON `sessions` (`worktree`);--> statement-breakpoint
CREATE INDEX `sessions_parent` ON `sessions` (`parent`);--> statement-breakpoint
CREATE INDEX `worktrees_repository` ON `worktrees` (`repository`);
--> statement-breakpoint
CREATE TRIGGER `hosts_insert` AFTER INSERT ON `hosts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('hosts'); END;

--> statement-breakpoint
CREATE TRIGGER `hosts_update` AFTER UPDATE ON `hosts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('hosts'); END;

--> statement-breakpoint
CREATE TRIGGER `hosts_delete` AFTER DELETE ON `hosts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('hosts'); END;

--> statement-breakpoint
CREATE TRIGGER `repositories_insert` AFTER INSERT ON `repositories` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repositories'); END;

--> statement-breakpoint
CREATE TRIGGER `repositories_update` AFTER UPDATE ON `repositories` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repositories'); END;

--> statement-breakpoint
CREATE TRIGGER `repositories_delete` AFTER DELETE ON `repositories` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repositories'); END;

--> statement-breakpoint
CREATE TRIGGER `worktrees_insert` AFTER INSERT ON `worktrees` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER `worktrees_update` AFTER UPDATE ON `worktrees` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER `worktrees_delete` AFTER DELETE ON `worktrees` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER `sessions_insert` AFTER INSERT ON `sessions` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('sessions'); END;

--> statement-breakpoint
CREATE TRIGGER `sessions_update` AFTER UPDATE ON `sessions` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('sessions'); END;

--> statement-breakpoint
CREATE TRIGGER `sessions_delete` AFTER DELETE ON `sessions` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('sessions'); END;

--> statement-breakpoint
CREATE TRIGGER `owned_worktrees_insert` AFTER INSERT ON `owned_worktrees` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('owned_worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER `owned_worktrees_update` AFTER UPDATE ON `owned_worktrees` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('owned_worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER `owned_worktrees_delete` AFTER DELETE ON `owned_worktrees` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('owned_worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER `pending_removals_insert` AFTER INSERT ON `pending_removals` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('pending_removals'); END;

--> statement-breakpoint
CREATE TRIGGER `pending_removals_update` AFTER UPDATE ON `pending_removals` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('pending_removals'); END;

--> statement-breakpoint
CREATE TRIGGER `pending_removals_delete` AFTER DELETE ON `pending_removals` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('pending_removals'); END;

--> statement-breakpoint
CREATE TRIGGER `worktree_parents_insert` AFTER INSERT ON `worktree_parents` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('worktree_parents'); END;

--> statement-breakpoint
CREATE TRIGGER `worktree_parents_update` AFTER UPDATE ON `worktree_parents` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('worktree_parents'); END;

--> statement-breakpoint
CREATE TRIGGER `worktree_parents_delete` AFTER DELETE ON `worktree_parents` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('worktree_parents'); END;

--> statement-breakpoint
CREATE TRIGGER `quarantine_insert` AFTER INSERT ON `quarantine` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('quarantine'); END;

--> statement-breakpoint
CREATE TRIGGER `quarantine_update` AFTER UPDATE ON `quarantine` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('quarantine'); END;

--> statement-breakpoint
CREATE TRIGGER `quarantine_delete` AFTER DELETE ON `quarantine` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('quarantine'); END;
