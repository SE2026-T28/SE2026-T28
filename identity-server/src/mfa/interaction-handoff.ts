import type { MfaChallengeService, MfaVerificationResult } from "./service.js";

export interface VerifyMfaInteractionInput {
  interactionUid: string;
  browserBinding: string;
  code: string;
  clientId?: string;
}

/**
 * Verifies the challenge selected by the persisted interaction/browser binding
 * and invokes the Provider completion callback only after one-time consumption.
 * The caller must validate its interaction-specific CSRF token before calling.
 */
export async function verifyMfaAndFinishInteraction(
  service: MfaChallengeService,
  input: VerifyMfaInteractionInput,
  finishLogin: (accountId: string) => Promise<unknown> | unknown,
): Promise<MfaVerificationResult> {
  const verified = await service.verifyPendingChallenge(input);
  if (!verified.ok) return verified;

  // Only this branch can reach Provider interaction completion. The account ID
  // comes from the row that was atomically consumed, never from request data.
  await finishLogin(verified.userId);
  return verified;
}
