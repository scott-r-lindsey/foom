import { errorMessage } from "../../shared/application-errors";
export function message(error: unknown): string {
  return errorMessage(error, "Unable to update settings.");
}
