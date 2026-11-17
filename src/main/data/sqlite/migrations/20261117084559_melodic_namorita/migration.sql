CREATE TABLE `environment_entries` (
	`scope` text NOT NULL,
	`fold` text NOT NULL,
	`name` text NOT NULL,
	`secret` integer NOT NULL,
	`value` text,
	`cipher` blob,
	CONSTRAINT `environment_entries_pk` PRIMARY KEY(`scope`, `fold`),
	CONSTRAINT `fk_environment_entries_scope_environment_scopes_scope_fk` FOREIGN KEY (`scope`) REFERENCES `environment_scopes`(`scope`) ON DELETE RESTRICT,
	CONSTRAINT "environment_secret" CHECK("secret" IN (0,1)),
	CONSTRAINT "environment_storage" CHECK(("secret"=1 AND "value" IS NULL AND "cipher" IS NOT NULL AND length("cipher") BETWEEN 1 AND 16384) OR ("secret"=0 AND "value" IS NOT NULL AND "cipher" IS NULL AND length("value")<=4096)),
	CONSTRAINT "environment_name" CHECK(length("name") BETWEEN 1 AND 256)
) STRICT;
--> statement-breakpoint
CREATE TABLE `environment_scopes` (
	`scope` text PRIMARY KEY NOT NULL
) STRICT;
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE `__new_profile_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "profile_settings_key" CHECK("key" IN ('setupComplete','checkForUpdates','agyPluginOfferAnswered','hooks','agentHooks','restoreSessions','showNewChildren','closeFinishedAgents','wakeOrchestrator','wakeIntervalMinutes','concurrentChildren','defaultAgent','recentRepositoryDays','unreadChildMinutes','autoRemoveMergedWorktrees','showPullRequests','showNestedRepositoryNames','middleClickPaste','copyOnSelect','terminalClipboardWrites','forges','forgeHosts','agents','agentArguments','worktreeLocation','panelColor','interfaceTheme','interfaceScale','terminalFontSize','terminalFont','terminalTheme','sound','codeFolder')),
	CONSTRAINT "profile_settings_json" CHECK(json_valid("value")),
	CONSTRAINT "profile_settings_boolean" CHECK("key" NOT IN ('setupComplete','checkForUpdates','agyPluginOfferAnswered','hooks','restoreSessions','showNewChildren','closeFinishedAgents','wakeOrchestrator','autoRemoveMergedWorktrees','showPullRequests','showNestedRepositoryNames','middleClickPaste','copyOnSelect','terminalClipboardWrites') OR json_type("value") IN ('true','false')),
	CONSTRAINT "profile_settings_location" CHECK("key" != 'worktreeLocation' OR COALESCE(json_extract("value", '$') IN ('root','adjacent'), 0)),
	CONSTRAINT "profile_settings_panel" CHECK("key" != 'panelColor' OR COALESCE(json_extract("value", '$') IN ('vivid','subtle','plain'), 0))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_profile_settings`(`key`, `value`) SELECT `key`, `value` FROM `profile_settings`;--> statement-breakpoint
DROP TABLE `profile_settings`;--> statement-breakpoint
ALTER TABLE `__new_profile_settings` RENAME TO `profile_settings`;--> statement-breakpoint

CREATE TRIGGER `environment_scopes_insert` AFTER INSERT ON `environment_scopes` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('environment_scopes'); END;

CREATE TRIGGER `environment_scopes_update` AFTER UPDATE ON `environment_scopes` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('environment_scopes'); END;

CREATE TRIGGER `environment_scopes_delete` AFTER DELETE ON `environment_scopes` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('environment_scopes'); END;

CREATE TRIGGER `environment_entries_insert` AFTER INSERT ON `environment_entries` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('environment_entries'); END;

CREATE TRIGGER `environment_entries_update` AFTER UPDATE ON `environment_entries` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('environment_entries'); END;

CREATE TRIGGER `environment_entries_delete` AFTER DELETE ON `environment_entries` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('environment_entries'); END;

CREATE TRIGGER `profile_settings_insert` AFTER INSERT ON `profile_settings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_settings'); END;

CREATE TRIGGER `profile_settings_update` AFTER UPDATE ON `profile_settings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_settings'); END;

CREATE TRIGGER `profile_settings_delete` AFTER DELETE ON `profile_settings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_settings'); END;
