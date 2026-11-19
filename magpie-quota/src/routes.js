/**
 * The panel's one Host route.
 *
 * A profile-installed bundle cannot declare a Remote namespace — client
 * namespaces come from a fixed list compiled into the web application — so the
 * browser half reads through an exact Fetch route on the harness's
 * authenticated `/api` channel. The Host/Origin fence and browser
 * authentication have already run before this handler is reached, which is why
 * this module adds no authentication of its own and must not be mounted
 * anywhere else.
 *
 * The route is a GET with no parameters: there is one magpie gateway and one
 * quota listing, both fixed by configuration.
 *
 * Failure codes are closed and carry no endpoint, so the channel cannot be used
 * to probe what is listening on the machine.
 *
 * @module dsh-magpie-quota/routes
 */

import { sendJson } from '../../shared/route.js'
import { fetchQuotas } from './gateway.js'
import { normalizeQuotas } from './quotas.js'

/** The one route this bundle serves. */
export const QUOTAS_PATH = '/api/plugin-magpie-quota/quotas'

/**
 * The status that belongs with each failure code.
 *
 * A failure to reach magpie is not the caller's fault, so it is reported as a
 * gateway problem rather than a 4xx. `bad_payload` is the one code that means
 * magpie answered something this plugin cannot read.
 */
const FAILURE_STATUS = {
  unreachable: 503,
  timeout: 504,
  bad_status: 502,
  bad_json: 502,
  too_large: 502,
  bad_payload: 502,
}

/**
 * One failure response.
 * @param error - the thrown value.
 * @returns the response.
 */
function sendFailure(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal'
  return sendJson(FAILURE_STATUS[code] ?? 500, { ok: false, error: code })
}

/**
 * Build the route definition for `ctx.connection.fetch.register`.
 * @param config - the resolved plugin configuration, closed over here.
 * @returns the route definitions.
 */
export function buildRoutes(config) {
  // Built once per load: the set is read on every request but never rebuilt.
  const hidden = new Set(config.hiddenWindows)
  return [
    {
      path: QUOTAS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const payload = await fetchQuotas(config)
          const { readAt, accounts } = normalizeQuotas(payload, hidden)
          return sendJson(200, { ok: true, readAt, accounts })
        } catch (error) {
          return sendFailure(error)
        }
      },
    },
  ]
}
