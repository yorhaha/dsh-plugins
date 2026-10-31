/**
 * Outbound mail: turn tool arguments into a Graph message and send it.
 *
 * Sending is the one write this plugin performs. The Graph call itself is a
 * single `POST /me/sendMail`; the care is in what goes into it: recipients are
 * parsed and validated here, a message with no recipient is refused before any
 * request is made, and the address count is bounded so one call cannot address a
 * mailing list. The composed message is built by a pure function so the mapping
 * can be checked without a network or a mailbox.
 *
 * @module dsh-outlook/src/send
 */

/** Most recipients one message may address, across to, cc, and bcc. */
export const MAX_RECIPIENTS = 100

/** A conservative address shape; Graph does the authoritative validation. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * A caller-correctable argument defect.
 * @param code - Stable machine code.
 * @param message - Detail for the model.
 * @returns the error to throw.
 */
function usageError(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Normalize one recipient argument into Graph `recipient` objects.
 *
 * An entry may be a bare address string, or an object carrying `address` (and
 * optionally `name`). Blanks are skipped, addresses are deduplicated
 * case-insensitively, and the first malformed address fails the whole call so a
 * typo is never silently dropped onto a smaller audience.
 *
 * @param list - Raw argument, expected to be an array.
 * @param field - Argument name, named in the failure.
 * @returns the Graph recipients, in input order.
 */
function toRecipients(list, field) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) {
    throw usageError('invalid_recipient', `${field} must be an array of email addresses`)
  }
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const address = typeof raw === 'string'
      ? raw.trim()
      : (raw !== null && typeof raw === 'object' && typeof raw.address === 'string' ? raw.address.trim() : '')
    if (address === '') continue
    if (!EMAIL_RE.test(address)) {
      throw usageError('invalid_recipient', `${field} contains an invalid email address: ${address}`)
    }
    const key = address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const name = raw !== null && typeof raw === 'object' && typeof raw.name === 'string' && raw.name.trim() !== ''
      ? raw.name.trim()
      : undefined
    out.push({ emailAddress: name === undefined ? { address } : { address, name } })
  }
  return out
}

/**
 * The addresses of already-built recipients.
 * @param recipients - Graph `recipient` objects.
 * @returns the bare addresses.
 */
function addressesOf(recipients) {
  return recipients.map((recipient) => recipient.emailAddress.address)
}

/**
 * Build a Graph message from tool arguments.
 *
 * @param args - Raw tool arguments.
 * @param args.to - Primary recipients.
 * @param args.cc - Carbon-copy recipients.
 * @param args.bcc - Blind-carbon-copy recipients.
 * @param args.subject - Subject line.
 * @param args.body - Body content.
 * @param args.bodyType - `text` (default) or `html`.
 * @param args.importance - `low`, `normal`, or `high`.
 * @returns the Graph message and a summary for the tool's output.
 * @throws with code `no_recipients`, `invalid_recipient`, or `too_many_recipients`.
 */
export function composeMessage({ to, cc, bcc, subject, body, bodyType = 'text', importance } = {}) {
  const toR = toRecipients(to, 'to')
  const ccR = toRecipients(cc, 'cc')
  const bccR = toRecipients(bcc, 'bcc')
  const total = toR.length + ccR.length + bccR.length
  if (total === 0) {
    throw usageError('no_recipients', 'a message needs at least one recipient among to, cc, or bcc')
  }
  if (total > MAX_RECIPIENTS) {
    throw usageError('too_many_recipients', `a message may address at most ${MAX_RECIPIENTS} recipients`)
  }
  const type = bodyType === 'html' ? 'html' : 'text'
  const level = importance === 'low' || importance === 'normal' || importance === 'high' ? importance : undefined
  const message = {
    subject: typeof subject === 'string' ? subject : '',
    body: { contentType: type === 'html' ? 'HTML' : 'Text', content: typeof body === 'string' ? body : '' },
    toRecipients: toR,
  }
  if (ccR.length > 0) message.ccRecipients = ccR
  if (bccR.length > 0) message.bccRecipients = bccR
  if (level !== undefined) message.importance = level
  return {
    message,
    summary: {
      to: addressesOf(toR),
      cc: addressesOf(ccR),
      bcc: addressesOf(bccR),
      subject: message.subject,
      bodyType: type,
      importance: level ?? null,
    },
  }
}

/**
 * Send one composed message.
 *
 * `/me/sendMail` answers 202 with an empty body, which the Graph client already
 * turns into `null`; this returns whichever body the service sent so a caller
 * that ever gets one is not surprised.
 *
 * @param options - Send options.
 * @param options.client - Authenticated Graph client.
 * @param options.message - The Graph message from {@link composeMessage}.
 * @param options.saveToSentItems - Keep a copy in Sent Items (default true).
 * @returns the parsed response body, or null.
 * @throws {GraphError} with a stable code.
 */
export async function sendMail({ client, message, saveToSentItems = true }) {
  return client.post('/me/sendMail', { body: { message, saveToSentItems } })
}
