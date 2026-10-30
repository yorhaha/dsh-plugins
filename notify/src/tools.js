/**
 * The agent-facing half: one tool that pushes a message to the user's phone.
 *
 * The tool is a projection of the `notify` service, not a second delivery path:
 * it reads the arguments, calls `notify.send`, and maps the outcome onto the
 * payload the model reads. Truncation, fan-out, timeouts, and failure codes live
 * in the service, so the calendar's reminders and the model's messages cannot
 * disagree about any of them.
 *
 * An expected send failure — no configured target, a refused token, an
 * unreachable endpoint — comes back as an `ok: false` payload carrying a closed
 * `error`/failure code, so the model reads the failure and decides what to do
 * instead of losing the call; nothing here throws.
 *
 * @module dsh-notify/src/tools
 */

/** Longest raw input a call card shows. */
const CARD_EXCERPT_CHARS = 200

/** The closed failure value returned when no target is configured. */
const NOT_CONFIGURED_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'error'],
  properties: {
    ok: { type: 'boolean', const: false },
    source: { type: 'string', const: 'notify' },
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string', const: 'not_configured' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

/** One target that did not receive the message. */
const FAILURE_SCHEMA = {
  type: 'object',
  required: ['target', 'code', 'message', 'retryable'],
  properties: {
    target: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
  },
  additionalProperties: false,
}

/** Every target received the message. */
const DELIVERED_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'delivered', 'total', 'title_truncated', 'content_truncated'],
  properties: {
    ok: { type: 'boolean', const: true },
    source: { type: 'string', const: 'notify' },
    delivered: { type: 'integer' },
    total: { type: 'integer' },
    title_truncated: { type: 'boolean' },
    content_truncated: { type: 'boolean' },
  },
  additionalProperties: false,
}

/** One call that carried no message to send. */
const INVALID_CONTENT_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'error'],
  properties: {
    ok: { type: 'boolean', const: false },
    source: { type: 'string', const: 'notify' },
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string', const: 'invalid_content' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

/** At least one target was attempted and at least one did not receive the message. */
const PARTIAL_SCHEMA = {
  type: 'object',
  required: ['ok', 'source', 'delivered', 'total', 'failures', 'title_truncated', 'content_truncated'],
  properties: {
    ok: { type: 'boolean', const: false },
    source: { type: 'string', const: 'notify' },
    delivered: { type: 'integer' },
    total: { type: 'integer' },
    failures: { type: 'array', items: FAILURE_SCHEMA },
    title_truncated: { type: 'boolean' },
    content_truncated: { type: 'boolean' },
  },
  additionalProperties: false,
}

/** Output contract of the notification tool. */
const NOTIFY_OUTPUT = { oneOf: [DELIVERED_SCHEMA, PARTIAL_SCHEMA, NOT_CONFIGURED_SCHEMA, INVALID_CONTENT_SCHEMA] }

/**
 * Build the tool bound to this plugin instance.
 *
 * @param options - Tool inputs.
 * @param options.notify - The delivery service this plugin provides.
 * @param options.config - The resolved plugin configuration.
 * @returns the tool definition, in registration order.
 */
export function buildTools({ notify, config }) {
  return [
    {
      name: 'notify_send',
      description:
        `Send a push notification to the user's phone through PushPlus, which reaches them outside this conversation (usually in WeChat). `
        + 'Use it when the user asks to be notified or reminded, or when work they are waiting on finishes while they may be away from the Harness. '
        + 'Delivery is one-way: the user cannot answer through it, and replying here is still how they respond. '
        + `Write the message as plain text that stands on its own, at most ${config.contentMaxChars} characters; it is sent to every target the user configured.`,
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: `Message body, plain text. Longer than ${config.contentMaxChars} characters is truncated.`,
          },
          title: {
            type: 'string',
            description: `Short subject line. Defaults to "${config.defaultTitle}".`,
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      output: { schema: NOTIFY_OUTPUT, render: renderValue },
      timeoutMs: config.toolTimeoutMs,
      isConcurrencySafe: () => true,
      presentCall: (args) => present(args),
      execute: async (args, exec) => {
        const raw = readText(args?.content)
        if (raw.trim() === '') {
          return {
            ok: false,
            source: 'notify',
            error: {
              code: 'invalid_content',
              message: 'notify_send needs a non-empty content field.',
              retryable: false,
            },
          }
        }
        const outcome = await notify.send({
          title: readTitle(args?.title, config.defaultTitle),
          content: raw,
          signal: exec?.signal,
        })
        if (outcome.code === 'not_configured') {
          return {
            ok: false,
            source: 'notify',
            error: {
              code: 'not_configured',
              message: 'No notification target is configured. The user adds a PushPlus token on the Plugins page, on the Notifications row.',
              retryable: false,
            },
          }
        }
        if (outcome.code === 'invalid_content') {
          return {
            ok: false,
            source: 'notify',
            error: {
              code: 'invalid_content',
              message: outcome.message ?? 'notify_send needs a non-empty content field.',
              retryable: false,
            },
          }
        }
        const failures = (outcome.failures ?? []).map(failure => ({
          target: failure.target,
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        }))
        return {
          ok: outcome.ok === true,
          source: 'notify',
          delivered: outcome.delivered,
          total: outcome.total,
          ...(failures.length === 0 ? {} : { failures }),
          title_truncated: outcome.title_truncated === true,
          content_truncated: outcome.content_truncated === true,
        }
      },
    },
  ]
}

/**
 * The pending-call card: what this notification says, not how it is sent.
 * @param args - The raw tool arguments.
 * @returns the call view.
 */
function present(args) {
  const content = readText(args?.content)
  const excerpt = content.length > CARD_EXCERPT_CHARS ? `${content.slice(0, CARD_EXCERPT_CHARS)}…` : content
  return {
    card: 'generic',
    title: 'Send a notification',
    ...(excerpt === '' ? {} : { rawInput: excerpt }),
  }
}

/**
 * Read the body argument.
 * @param value - Raw argument.
 * @returns the body text.
 */
function readText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Read the title argument, falling back to the configured default.
 *
 * @param value - Raw argument.
 * @param fallback - Title used when the argument is absent or blank.
 * @returns the title text.
 */
function readTitle(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? fallback : text
}

/**
 * Render the tool value as the model reads it.
 * @param _args - The tool arguments, unused.
 * @param value - The tool value.
 * @returns one JSON text block.
 */
function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}
