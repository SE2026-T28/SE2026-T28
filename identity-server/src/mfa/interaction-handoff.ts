import type { MfaChallengeService, MfaVerificationResult } from "./service.js";

export interface VerifyMfaInteractionInput {
  interactionUid: string;
  browserBinding: string;
  code: string;
  clientId?: string;
}

/**
 * A verified challenge is consumed before the Provider callback is invoked.
 * If that callback fails, the old challenge must stay consumed: retrying it
 * could replay MFA or repeat a partially completed Provider operation.
 *
 * The caller must treat `interaction_failed` as a terminal result for the
 * current interaction and ask the client to start a completely new OIDC
 * authorization interaction (including password and MFA again). Never retry
 * `finishLogin` with the consumed challenge and never expose the provider error.
 *
 * The caller must validate its interaction-specific CSRF token before calling.
 */
export type MfaInteractionHandoffResult = MfaVerificationResult | {
  ok: false;
  reason: "interaction_failed";
  recovery: "start_new_interaction";
};

export async function verifyMfaAndFinishInteraction(
  service: MfaChallengeService,
  input: VerifyMfaInteractionInput,
  finishLogin: (accountId: string) => Promise<unknown> | unknown,
): Promise<MfaInteractionHandoffResult> {
  const verified = await service.verifyPendingChallenge(input);
  if (!verified.ok) return verified;

  // Only this branch can reach Provider interaction completion. The account ID
  // comes from the row that was atomically consumed, never from request data.
  try {
    await finishLogin(verified.userId);
  } catch {
    // The challenge remains CONSUMED. Do not leak provider internals, retry the
    // callback, or report MFA success when the interaction handoff did not
    // resolve. A new authorization interaction must issue a fresh challenge.
    return {
      ok: false,
      reason: "interaction_failed",
      recovery: "start_new_interaction",
    };
  }

  return verified;
}
