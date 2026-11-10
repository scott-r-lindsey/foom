CREATE TABLE `_changes` (
	`revision` integer PRIMARY KEY AUTOINCREMENT,
	`table_name` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	CONSTRAINT `fk_repositories_host_id_hosts_id_fk` FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON DELETE RESTRICT
) STRICT;
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY,
	`worktree_id` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `fk_sessions_worktree_id_worktrees_id_fk` FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "session_state" CHECK("state" IN ('running', 'exited'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	CONSTRAINT `fk_worktrees_repository_id_repositories_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON DELETE RESTRICT
) STRICT;
--> statement-breakpoint
CREATE INDEX `repositories_host` ON `repositories` (`host_id`);--> statement-breakpoint
CREATE INDEX `sessions_worktree` ON `sessions` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `worktrees_repository` ON `worktrees` (`repository_id`);
--> statement-breakpoint
CREATE TRIGGER hosts_insert AFTER INSERT ON hosts BEGIN INSERT INTO _changes(table_name) VALUES ('hosts'); END;

--> statement-breakpoint
CREATE TRIGGER hosts_update AFTER UPDATE ON hosts BEGIN INSERT INTO _changes(table_name) VALUES ('hosts'); END;

--> statement-breakpoint
CREATE TRIGGER hosts_delete AFTER DELETE ON hosts BEGIN INSERT INTO _changes(table_name) VALUES ('hosts'); END;

--> statement-breakpoint
CREATE TRIGGER repositories_insert AFTER INSERT ON repositories BEGIN INSERT INTO _changes(table_name) VALUES ('repositories'); END;

--> statement-breakpoint
CREATE TRIGGER repositories_update AFTER UPDATE ON repositories BEGIN INSERT INTO _changes(table_name) VALUES ('repositories'); END;

--> statement-breakpoint
CREATE TRIGGER repositories_delete AFTER DELETE ON repositories BEGIN INSERT INTO _changes(table_name) VALUES ('repositories'); END;

--> statement-breakpoint
CREATE TRIGGER worktrees_insert AFTER INSERT ON worktrees BEGIN INSERT INTO _changes(table_name) VALUES ('worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER worktrees_update AFTER UPDATE ON worktrees BEGIN INSERT INTO _changes(table_name) VALUES ('worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER worktrees_delete AFTER DELETE ON worktrees BEGIN INSERT INTO _changes(table_name) VALUES ('worktrees'); END;

--> statement-breakpoint
CREATE TRIGGER sessions_insert AFTER INSERT ON sessions BEGIN INSERT INTO _changes(table_name) VALUES ('sessions'); END;

--> statement-breakpoint
CREATE TRIGGER sessions_update AFTER UPDATE ON sessions BEGIN INSERT INTO _changes(table_name) VALUES ('sessions'); END;

--> statement-breakpoint
CREATE TRIGGER sessions_delete AFTER DELETE ON sessions BEGIN INSERT INTO _changes(table_name) VALUES ('sessions'); END;
