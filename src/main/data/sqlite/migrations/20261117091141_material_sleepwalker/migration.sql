CREATE TABLE `agent_health` (
	`namespace` text NOT NULL,
	`agent` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `agent_health_pk` PRIMARY KEY(`namespace`, `agent`),
	CONSTRAINT "health_state" CHECK("state" IN ('trusted','declined','outdated','not-reviewed')),
	CONSTRAINT "health_fingerprint" CHECK(length("fingerprint")=64 AND "fingerprint" NOT GLOB '*[^a-f0-9]*')
) STRICT;
--> statement-breakpoint
CREATE TABLE `audit_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`operation_snapshot` text NOT NULL,
	`timestamp` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "audit_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `board_bindings` (
	`thread` text NOT NULL,
	`repository` text NOT NULL,
	CONSTRAINT `board_bindings_pk` PRIMARY KEY(`thread`, `repository`),
	CONSTRAINT `fk_board_bindings_thread_board_threads_id_fk` FOREIGN KEY (`thread`) REFERENCES `board_threads`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_board_bindings_repository_repositories_path_fk` FOREIGN KEY (`repository`) REFERENCES `repositories`(`path`) ON DELETE RESTRICT
) STRICT;
--> statement-breakpoint
CREATE TABLE `board_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`thread` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_board_posts_thread_board_threads_id_fk` FOREIGN KEY (`thread`) REFERENCES `board_threads`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "board_post_kind" CHECK("kind" IN ('request','answer','decision-needed','fyi','link')),
	CONSTRAINT "board_post_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `board_receipts` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`hash` text NOT NULL,
	`thread` text NOT NULL,
	`post` text,
	CONSTRAINT `board_receipts_pk` PRIMARY KEY(`scope`, `key`),
	CONSTRAINT `fk_board_receipts_thread_board_threads_id_fk` FOREIGN KEY (`thread`) REFERENCES `board_threads`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_board_receipts_post_thread_board_posts_id_thread_fk` FOREIGN KEY (`post`,`thread`) REFERENCES `board_posts`(`id`,`thread`) ON DELETE RESTRICT
) STRICT;
--> statement-breakpoint
CREATE TABLE `board_recipients` (
	`thread` text NOT NULL,
	`repository_snapshot` text NOT NULL,
	CONSTRAINT `board_recipients_pk` PRIMARY KEY(`thread`, `repository_snapshot`),
	CONSTRAINT `fk_board_recipients_thread_board_threads_id_fk` FOREIGN KEY (`thread`) REFERENCES `board_threads`(`id`) ON DELETE RESTRICT
) STRICT;
--> statement-breakpoint
CREATE TABLE `board_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`removed_at` text,
	`data` text NOT NULL,
	CONSTRAINT "board_thread_state" CHECK("state" IN ('open','waiting-repo','waiting-human','resolved')),
	CONSTRAINT "board_thread_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `control_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`key_hash` text NOT NULL,
	`fingerprint` text NOT NULL,
	`generation` text NOT NULL,
	`recovered` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "operation_action" CHECK("action" IN ('wake','create_worktree','launch','stop','close','remove_worktree','prompt','send_keys','reply','board_post','board_resolve')),
	CONSTRAINT "operation_status" CHECK("status" IN ('pending_confirmation','running','succeeded','failed','declined','cancelled','indeterminate')),
	CONSTRAINT "operation_recovered" CHECK("recovered" IN (0,1)),
	CONSTRAINT "operation_json" CHECK(json_valid("data")),
	CONSTRAINT "operation_hashes" CHECK(length("key_hash")=64 AND "key_hash" NOT GLOB '*[^a-f0-9]*' AND length("fingerprint")=64 AND "fingerprint" NOT GLOB '*[^a-f0-9]*')
) STRICT;
--> statement-breakpoint
CREATE TABLE `forge_observations` (
	`path` text PRIMARY KEY NOT NULL,
	`host` text,
	`repository` text,
	`worktree` text,
	`data` text NOT NULL,
	CONSTRAINT `fk_forge_observations_host_hosts_alias_fk` FOREIGN KEY (`host`) REFERENCES `hosts`(`alias`) ON DELETE RESTRICT,
	CONSTRAINT `fk_forge_observations_repository_repositories_path_fk` FOREIGN KEY (`repository`) REFERENCES `repositories`(`path`) ON DELETE RESTRICT,
	CONSTRAINT `fk_forge_observations_worktree_worktrees_path_fk` FOREIGN KEY (`worktree`) REFERENCES `worktrees`(`path`) ON DELETE RESTRICT,
	CONSTRAINT "forge_observations_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `offers` (
	`category` text NOT NULL,
	`agent` text NOT NULL,
	`answered` integer NOT NULL,
	CONSTRAINT `offers_pk` PRIMARY KEY(`category`, `agent`),
	CONSTRAINT "offer_category" CHECK("category" IN ('setup','probe-notice')),
	CONSTRAINT "offer_answer" CHECK("answered" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `operation_audit_links` (
	`operation` text NOT NULL,
	`audit` integer NOT NULL,
	CONSTRAINT `operation_audit_links_pk` PRIMARY KEY(`operation`, `audit`),
	CONSTRAINT `fk_operation_audit_links_operation_control_operations_id_fk` FOREIGN KEY (`operation`) REFERENCES `control_operations`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_operation_audit_links_audit_audit_records_id_fk` FOREIGN KEY (`audit`) REFERENCES `audit_records`(`id`) ON DELETE RESTRICT
) STRICT;
--> statement-breakpoint
CREATE TABLE `repository_approvals` (
	`repository` text PRIMARY KEY NOT NULL,
	`registration` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_repository_approvals_repository_registration_repositories_path_registration_fk` FOREIGN KEY (`repository`,`registration`) REFERENCES `repositories`(`path`,`registration`) ON DELETE RESTRICT,
	CONSTRAINT "repository_approval_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `repository_observations` (
	`repository` text NOT NULL,
	`machine` text NOT NULL,
	`host` text,
	`state` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `repository_observations_pk` PRIMARY KEY(`repository`, `machine`),
	CONSTRAINT `fk_repository_observations_repository_repositories_path_fk` FOREIGN KEY (`repository`) REFERENCES `repositories`(`path`) ON DELETE RESTRICT,
	CONSTRAINT `fk_repository_observations_host_hosts_alias_fk` FOREIGN KEY (`host`) REFERENCES `hosts`(`alias`) ON DELETE RESTRICT,
	CONSTRAINT "repository_observation_state" CHECK("state" IN ('no-list','not-checked','met','needs-setup','review-needed','unable','manual')),
	CONSTRAINT "repository_observation_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `terminal_diagnostics` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "terminal_diagnostic_kind" CHECK("kind" IN ('exit','timeout','near-miss')),
	CONSTRAINT "terminal_diagnostic_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `verdict_actions` (
	`verdict` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`timestamp` text NOT NULL,
	CONSTRAINT `fk_verdict_actions_verdict_verdict_records_id_fk` FOREIGN KEY (`verdict`) REFERENCES `verdict_records`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "verdict_action" CHECK("action" IN ('replied','dismissed','ignored'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `verdict_records` (
	`id` text PRIMARY KEY NOT NULL,
	`terminal_snapshot` text NOT NULL,
	`state` text NOT NULL,
	`timestamp` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT "verdict_state" CHECK("state" IN ('needs_input','done','failed','quiet_ok','working')),
	CONSTRAINT "verdict_json" CHECK(json_valid("data"))
) STRICT;
--> statement-breakpoint
CREATE INDEX `audit_operation` ON `audit_records` (`operation_snapshot`);--> statement-breakpoint
CREATE INDEX `audit_timestamp` ON `audit_records` (`timestamp`);--> statement-breakpoint
CREATE INDEX `board_bindings_repository` ON `board_bindings` (`repository`);--> statement-breakpoint
CREATE INDEX `board_posts_thread` ON `board_posts` (`thread`);--> statement-breakpoint
CREATE UNIQUE INDEX `board_post_identity` ON `board_posts` (`id`,`thread`);--> statement-breakpoint
CREATE INDEX `board_receipts_thread` ON `board_receipts` (`thread`);--> statement-breakpoint
CREATE INDEX `board_receipts_post` ON `board_receipts` (`post`,`thread`);--> statement-breakpoint
CREATE INDEX `board_thread_removal` ON `board_threads` (`removed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `operation_generation_key` ON `control_operations` (`generation`,`key_hash`);--> statement-breakpoint
CREATE INDEX `forge_host` ON `forge_observations` (`host`);--> statement-breakpoint
CREATE INDEX `forge_repository` ON `forge_observations` (`repository`);--> statement-breakpoint
CREATE INDEX `forge_worktree` ON `forge_observations` (`worktree`);--> statement-breakpoint
CREATE INDEX `operation_audit_record` ON `operation_audit_links` (`audit`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_registration_identity` ON `repositories` (`path`,`registration`);--> statement-breakpoint
CREATE INDEX `approval_registration` ON `repository_approvals` (`registration`);--> statement-breakpoint
CREATE INDEX `repository_observations_host` ON `repository_observations` (`host`);--> statement-breakpoint
CREATE INDEX `verdict_terminal` ON `verdict_records` (`terminal_snapshot`);
CREATE TRIGGER `board_threads_insert` AFTER INSERT ON `board_threads` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_threads'); END;

CREATE TRIGGER `board_threads_update` AFTER UPDATE ON `board_threads` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_threads'); END;

CREATE TRIGGER `board_threads_delete` AFTER DELETE ON `board_threads` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_threads'); END;

CREATE TRIGGER `board_posts_insert` AFTER INSERT ON `board_posts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_posts'); END;

CREATE TRIGGER `board_posts_update` AFTER UPDATE ON `board_posts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_posts'); END;

CREATE TRIGGER `board_posts_delete` AFTER DELETE ON `board_posts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_posts'); END;

CREATE TRIGGER `board_recipients_insert` AFTER INSERT ON `board_recipients` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_recipients'); END;

CREATE TRIGGER `board_recipients_update` AFTER UPDATE ON `board_recipients` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_recipients'); END;

CREATE TRIGGER `board_recipients_delete` AFTER DELETE ON `board_recipients` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_recipients'); END;

CREATE TRIGGER `board_bindings_insert` AFTER INSERT ON `board_bindings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_bindings'); END;

CREATE TRIGGER `board_bindings_update` AFTER UPDATE ON `board_bindings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_bindings'); END;

CREATE TRIGGER `board_bindings_delete` AFTER DELETE ON `board_bindings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_bindings'); END;

CREATE TRIGGER `board_receipts_insert` AFTER INSERT ON `board_receipts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_receipts'); END;

CREATE TRIGGER `board_receipts_update` AFTER UPDATE ON `board_receipts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_receipts'); END;

CREATE TRIGGER `board_receipts_delete` AFTER DELETE ON `board_receipts` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('board_receipts'); END;

CREATE TRIGGER `forge_observations_insert` AFTER INSERT ON `forge_observations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('forge_observations'); END;

CREATE TRIGGER `forge_observations_update` AFTER UPDATE ON `forge_observations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('forge_observations'); END;

CREATE TRIGGER `forge_observations_delete` AFTER DELETE ON `forge_observations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('forge_observations'); END;

CREATE TRIGGER `offers_insert` AFTER INSERT ON `offers` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('offers'); END;

CREATE TRIGGER `offers_update` AFTER UPDATE ON `offers` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('offers'); END;

CREATE TRIGGER `offers_delete` AFTER DELETE ON `offers` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('offers'); END;

CREATE TRIGGER `agent_health_insert` AFTER INSERT ON `agent_health` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('agent_health'); END;

CREATE TRIGGER `agent_health_update` AFTER UPDATE ON `agent_health` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('agent_health'); END;

CREATE TRIGGER `agent_health_delete` AFTER DELETE ON `agent_health` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('agent_health'); END;

CREATE TRIGGER `control_operations_insert` AFTER INSERT ON `control_operations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('control_operations'); END;

CREATE TRIGGER `control_operations_update` AFTER UPDATE ON `control_operations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('control_operations'); END;

CREATE TRIGGER `control_operations_delete` AFTER DELETE ON `control_operations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('control_operations'); END;

CREATE TRIGGER `audit_records_insert` AFTER INSERT ON `audit_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('audit_records'); END;

CREATE TRIGGER `audit_records_update` AFTER UPDATE ON `audit_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('audit_records'); END;

CREATE TRIGGER `audit_records_delete` AFTER DELETE ON `audit_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('audit_records'); END;

CREATE TRIGGER `operation_audit_links_insert` AFTER INSERT ON `operation_audit_links` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('operation_audit_links'); END;

CREATE TRIGGER `operation_audit_links_update` AFTER UPDATE ON `operation_audit_links` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('operation_audit_links'); END;

CREATE TRIGGER `operation_audit_links_delete` AFTER DELETE ON `operation_audit_links` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('operation_audit_links'); END;

CREATE TRIGGER `verdict_records_insert` AFTER INSERT ON `verdict_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('verdict_records'); END;

CREATE TRIGGER `verdict_records_update` AFTER UPDATE ON `verdict_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('verdict_records'); END;

CREATE TRIGGER `verdict_records_delete` AFTER DELETE ON `verdict_records` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('verdict_records'); END;

CREATE TRIGGER `verdict_actions_insert` AFTER INSERT ON `verdict_actions` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('verdict_actions'); END;

CREATE TRIGGER `verdict_actions_update` AFTER UPDATE ON `verdict_actions` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('verdict_actions'); END;

CREATE TRIGGER `verdict_actions_delete` AFTER DELETE ON `verdict_actions` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('verdict_actions'); END;

CREATE TRIGGER `repository_approvals_insert` AFTER INSERT ON `repository_approvals` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repository_approvals'); END;

CREATE TRIGGER `repository_approvals_update` AFTER UPDATE ON `repository_approvals` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repository_approvals'); END;

CREATE TRIGGER `repository_approvals_delete` AFTER DELETE ON `repository_approvals` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repository_approvals'); END;

CREATE TRIGGER `repository_observations_insert` AFTER INSERT ON `repository_observations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repository_observations'); END;

CREATE TRIGGER `repository_observations_update` AFTER UPDATE ON `repository_observations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repository_observations'); END;

CREATE TRIGGER `repository_observations_delete` AFTER DELETE ON `repository_observations` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('repository_observations'); END;

CREATE TRIGGER `terminal_diagnostics_insert` AFTER INSERT ON `terminal_diagnostics` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('terminal_diagnostics'); END;

CREATE TRIGGER `terminal_diagnostics_update` AFTER UPDATE ON `terminal_diagnostics` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('terminal_diagnostics'); END;

CREATE TRIGGER `terminal_diagnostics_delete` AFTER DELETE ON `terminal_diagnostics` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('terminal_diagnostics'); END;
