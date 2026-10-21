import { app } from "electron";
import { handleInstaller } from "./installer";
import { runApplication } from "./wiring/application";

if (!handleInstaller(app)) runApplication();
