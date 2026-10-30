/**
 * Validation for the five-field cron expression this plugin hands to the
 * schedule service.
 *
 * The schedule service rejects an out-of-range field only when a task is
 * created, which is long after the plugin loaded and, for `recreate`, after the
 * previous task was deleted. This module applies the same grammar at load so a
 * bad expression fails the load instead: `*`, `a`, `a-b`, and their `/n` forms,
 * comma-separated, in the fields minute, hour, day-of-month, month, and
 * day-of-week.
 *
 * @module dsh-bilibili/src/cron
 */

/** Accepted range per field, in the order of a five-field expression. */
const FIELDS = Object.freeze([
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
])

/**
 * Validate and normalize a cron expression.
 *
 * @param value - the configured expression.
 * @returns the expression with single spaces between its fields.
 * @throws when the value is not a five-field expression this scheduler accepts.
 */
export function assertCron(value) {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) {
    throw new Error('bilibili: config.scheduleCron must be a non-empty trimmed string')
  }
  const fields = value.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error('bilibili: config.scheduleCron must be a five-field cron expression')
  }
  fields.forEach((field, index) => {
    const spec = FIELDS[index]
    for (const element of field.split(',')) assertElement(element, spec)
  })
  return fields.join(' ')
}

/**
 * Validate one comma-separated element of a field.
 *
 * @param element - one element, without commas.
 * @param spec - the field's accepted range.
 * @throws when the element is malformed or out of range.
 */
function assertElement(element, spec) {
  if (element === '') {
    throw new Error(`bilibili: config.scheduleCron must not contain an empty ${spec.name} element`)
  }
  if (element === '*') return
  if (element.startsWith('*')) {
    const stepped = /^\*\/(\d+)$/.exec(element)
    if (stepped === null || Number(stepped[1]) < 1) {
      throw new Error(`bilibili: config.scheduleCron has an unusable ${spec.name} element "${element}"`)
    }
    return
  }
  const match = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(element)
  if (match === null) {
    throw new Error(`bilibili: config.scheduleCron has an unusable ${spec.name} element "${element}"`)
  }
  const start = readValue(match[1], spec)
  if (match[2] === undefined) {
    if (match[3] !== undefined) {
      throw new Error(`bilibili: config.scheduleCron cannot put a step on the single ${spec.name} value "${element}"`)
    }
    return
  }
  const end = readValue(match[2], spec)
  if (start > end) {
    throw new Error(`bilibili: config.scheduleCron has an inverted ${spec.name} range "${element}"`)
  }
  if (match[3] !== undefined && Number(match[3]) < 1) {
    throw new Error(`bilibili: config.scheduleCron has an unusable ${spec.name} step in "${element}"`)
  }
}

/**
 * Read one in-range field value.
 *
 * @param text - the decimal text.
 * @param spec - the field's accepted range.
 * @returns the value.
 * @throws when it is outside the range.
 */
function readValue(text, spec) {
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new Error(`bilibili: config.scheduleCron ${spec.name} value ${text} is outside ${spec.min}-${spec.max}`)
  }
  return value
}
