import type { HostGitFailureReason } from "../../shared/registered-hosts.d";

/** Only this fixed reason may escape the host; never retain raw Git diagnostics. */
export class HostGitFailure extends Error {
  constructor(readonly reason: HostGitFailureReason | "cancelled") {
    super(`Remote Git failed: ${reason}`);
  }
}

export function gitFailureReason(stderr: string): HostGitFailureReason {
  // Trust failures take precedence over the generic "could not read" suffix.
  if (
    /host key verification failed|remote host identification has changed|no .*host key is known|offending .* key/iu.test(
      stderr,
    )
  )
    return "origin-host-key";
  if (
    /permission denied \([^)]*(?:publickey|password|keyboard-interactive)|authentication failed|HTTP Basic: Access denied|requested URL returned error: (?:401|403)|permission denied, please try again|could not read (?:username|password)|terminal prompts disabled|invalid username or (?:password|token)|support for password authentication was removed|repository not found|enter passphrase|incorrect passphrase|sign_and_send_pubkey: signing failed/iu.test(
      stderr,
    )
  )
    return "origin-auth";
  if (/connection timed out|operation timed out|connection timeout/iu.test(stderr))
    return "timed-out";
  if (
    /not a git repository|invalid gitfile|bad object|not a valid object name|invalid refspec/iu.test(
      stderr,
    )
  )
    return "checkout-invalid";
  return "origin-unreachable";
}
