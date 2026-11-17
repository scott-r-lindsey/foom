CREATE TABLE `agent_consents` (
	`agent` text PRIMARY KEY NOT NULL,
	`acknowledged` integer NOT NULL,
	`identity` text,
	CONSTRAINT "agent_consents_boolean" CHECK("acknowledged" IN (0,1)),
	CONSTRAINT "agent_consents_identity" CHECK("identity" IS NULL OR (length("identity")=64 AND "identity" NOT GLOB '*[^a-f0-9]*'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `profile_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "profile_metadata_key" CHECK("key" IN ('remoteProfile','configVersion','configDigest','configText','themeDigests')),
	CONSTRAINT "profile_metadata_json" CHECK(json_valid("value"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `profile_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "profile_settings_key" CHECK("key" IN ('setupComplete','checkForUpdates','agyPluginOfferAnswered','hooks','agentHooks','restoreSessions','showNewChildren','closeFinishedAgents','wakeOrchestrator','wakeIntervalMinutes','concurrentChildren','defaultAgent','recentRepositoryDays','unreadChildMinutes','autoRemoveMergedWorktrees','showPullRequests','showNestedRepositoryNames','middleClickPaste','copyOnSelect','terminalClipboardWrites','forges','forgeHosts','agents','agentArguments','worktreeLocation','panelColor','interfaceTheme','interfaceScale','terminalFontSize','terminalFont','terminalTheme','sound','codeFolder')),
	CONSTRAINT "profile_settings_json" CHECK(json_valid("value")),
	CONSTRAINT "profile_settings_boolean" CHECK("key" NOT IN ('setupComplete','checkForUpdates','agyPluginOfferAnswered','hooks','restoreSessions','showNewChildren','closeFinishedAgents','wakeOrchestrator','autoRemoveMergedWorktrees','showPullRequests','showNestedRepositoryNames','middleClickPaste','copyOnSelect','terminalClipboardWrites') OR json_type("value") IN ('true','false')),
	CONSTRAINT "profile_settings_location" CHECK("key" != 'worktreeLocation' OR json_extract("value", '$') IN ('root','adjacent')),
	CONSTRAINT "profile_settings_panel" CHECK("key" != 'panelColor' OR json_extract("value", '$') IN ('vivid','subtle','plain'))
) STRICT;

CREATE TRIGGER `profile_settings_insert` AFTER INSERT ON `profile_settings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_settings'); END;

CREATE TRIGGER `profile_settings_update` AFTER UPDATE ON `profile_settings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_settings'); END;

CREATE TRIGGER `profile_settings_delete` AFTER DELETE ON `profile_settings` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_settings'); END;

CREATE TRIGGER `agent_consents_insert` AFTER INSERT ON `agent_consents` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('agent_consents'); END;

CREATE TRIGGER `agent_consents_update` AFTER UPDATE ON `agent_consents` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('agent_consents'); END;

CREATE TRIGGER `agent_consents_delete` AFTER DELETE ON `agent_consents` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('agent_consents'); END;

CREATE TRIGGER `profile_metadata_insert` AFTER INSERT ON `profile_metadata` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_metadata'); END;

CREATE TRIGGER `profile_metadata_update` AFTER UPDATE ON `profile_metadata` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_metadata'); END;

CREATE TRIGGER `profile_metadata_delete` AFTER DELETE ON `profile_metadata` BEGIN INSERT INTO `_changes` (`table_name`) VALUES ('profile_metadata'); END;
