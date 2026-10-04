import {PaymentError} from './alipay-payment-candidate.mjs';

export const WELCOME_CREDITS = 20_000;
const NANO_CNY_PER_CREDIT = 1_000_000n;

// A server policy, never a desktop-provided claim or amount. Unlimited testing
// and existing payment deployments keep their explicit policy unless opted in.
export function readWelcomeCreditPolicy(env, {quotaEnforced, payment} = {}) {
  const raw = env.GEOD_AGENT_WELCOME_CREDITS;
  if (raw == null && (!quotaEnforced || payment)) return null;
  const value = raw ?? String(WELCOME_CREDITS);
  if (!/^(0|[1-9][0-9]{0,6})$/.test(value) || Number(value) > 1_000_000)
    throw new PaymentError('WELCOME_CREDIT_CONFIG_INVALID', 'Invalid server welcome credit amount');
  const credits = Number(value);
  if (credits === 0) return null;
  if (!quotaEnforced || (payment && payment.billingMode !== 'enforced'))
    throw new PaymentError('WELCOME_CREDIT_CONFIG_INVALID', 'Welcome credit requires prepaid model settlement');
  const policyId = env.GEOD_AGENT_WELCOME_POLICY_ID || 'geod-agent-welcome-v1';
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(policyId))
    throw new PaymentError('WELCOME_CREDIT_CONFIG_INVALID', 'Invalid welcome credit policy version');
  return Object.freeze({policyId, creditNanoCny: String(BigInt(credits) * NANO_CNY_PER_CREDIT)});
}
