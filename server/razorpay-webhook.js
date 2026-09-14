/**
 * Razorpay webhook handling.
 *
 * The link between money arriving and the customer getting something. Razorpay
 * calls us when a subscription is charged, fails, or is cancelled; we issue,
 * extend or revoke a key.
 *
 * Three things this has to get right, because each one is a customer with a
 * grievance:
 *
 *   - verify the signature. Without it anyone who finds the URL can mint
 *     themselves a licence by posting fake JSON.
 *   - be idempotent. Razorpay retries failed deliveries, and a retry must not
 *     issue a second key to someone who already has one.
 *   - never fail silently. A webhook that 200s while doing nothing means a
 *     paying customer waits forever for an email, and Razorpay stops retrying
 *     because we said we handled it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Razorpay signs the raw body, so it must be compared byte for byte. Parsing
 * and re-serialising changes key order and whitespace and the signature stops
 * matching.
 */
export function verifySignature (rawBody, signature, secret) {
  if (!signature || !secret) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(String(signature), 'utf8')
  // Lengths must match before timingSafeEqual, which throws otherwise.
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Map a Razorpay plan id to one of ours. Configured per deployment. */
function planFor (planId, mapping) {
  return mapping[planId] || 'solo'
}

/**
 * Decide what a webhook means. Pure, so it can be tested without a server,
 * a database or Razorpay.
 *
 * Returns one of:
 *   { action: 'issue',  subscriptionId, plan, email, months }
 *   { action: 'extend', subscriptionId, months }
 *   { action: 'revoke', subscriptionId, reason }
 *   { action: 'ignore', reason }
 */
export function interpret (event, { planMapping = {} } = {}) {
  const type = event?.event
  const sub = event?.payload?.subscription?.entity
  const payment = event?.payload?.payment?.entity

  if (!type) return { action: 'ignore', reason: 'no event type' }

  switch (type) {
    case 'subscription.charged': {
      if (!sub?.id) return { action: 'ignore', reason: 'no subscription in payload' }
      // paid_count is how many times this subscription has been charged.
      // 1 means this is the first payment, so the customer is new.
      const first = (sub.paid_count ?? 1) <= 1
      return {
        action: first ? 'issue' : 'extend',
        subscriptionId: sub.id,
        plan: planFor(sub.plan_id, planMapping),
        email: payment?.email || sub.notes?.email || null,
        months: 1
      }
    }

    // Payment failed and Razorpay has given up retrying.
    case 'subscription.halted':
      return { action: 'revoke', subscriptionId: sub?.id, reason: 'payment failed' }

    case 'subscription.cancelled':
      return { action: 'revoke', subscriptionId: sub?.id, reason: 'cancelled' }

    case 'subscription.completed':
      return { action: 'revoke', subscriptionId: sub?.id, reason: 'subscription ended' }

    // Useful to see, but nothing to do: the customer has authorised the mandate
    // and the first charge event will follow.
    case 'subscription.authenticated':
    case 'subscription.activated':
    case 'subscription.pending':
    case 'subscription.updated':
      return { action: 'ignore', reason: type }

    default:
      return { action: 'ignore', reason: `unhandled event ${type}` }
  }
}

/**
 * Send the key.
 *
 * Falls back to logging when no email provider is configured, so the whole
 * flow can be exercised before any of that exists - and so a missing API key
 * never loses a customer's licence. It will be in the server log.
 */
export async function deliverKey ({ email, key, plan, brand = 'Verge', downloadUrl = '' }) {
  const subject = `Your ${brand} licence key`
  const body = [
    `Thanks for subscribing to ${brand}.`,
    '',
    `Your licence key:  ${key}`,
    '',
    'To get started:',
    `  1. Download ${brand}: ${downloadUrl || '(download link)'}`,
    '  2. Run it and paste the key above',
    '  3. Scan the QR code with WhatsApp on your phone',
    '  4. Restart Claude',
    '',
    'Then ask Claude something like "what\'s in my WhatsApp from this week?"',
    '',
    'Reply to this email if anything goes wrong and a human will help.'
  ].join('\n')

  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.LICENCE_FROM_EMAIL

  if (!apiKey || !from || !email) {
    console.log(`[webhook] no email sent (${!email ? 'no address' : 'no provider configured'})`)
    console.log(`[webhook] KEY FOR ${email || 'unknown'}: ${key} (${plan})`)
    return { sent: false, reason: !email ? 'no address' : 'no provider' }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: email, subject, text: body })
    })
    if (!res.ok) throw new Error(`resend returned ${res.status}`)
    return { sent: true }
  } catch (err) {
    // Loud, because the customer has paid and is waiting.
    console.error(`[webhook] EMAIL FAILED for ${email}: ${err.message}`)
    console.error(`[webhook] KEY THEY DID NOT RECEIVE: ${key}`)
    return { sent: false, reason: err.message }
  }
}
