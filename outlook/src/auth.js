/**
 * Microsoft sign-in: the device code flow, the stored token cache, and the
 * bearer token every Graph request carries.
 *
 * The user is sent to a Microsoft page with a short code, because the plugin
 * runs inside a Host process that owns no browser window. The token cache MSAL
 * produces is one opaque blob, stored verbatim as the payload of a single
 * credential record — the seam never interprets it, and the record is written
 * only by the sign-in flow.
 *
 * A sign-in starts from an empty cache and replaces the stored one whole on
 * success, so a half-finished attempt can never leave a mixture of two
 * accounts behind.
 *
 * @module dsh-outlook/src/auth
 */

import { InteractionRequiredAuthError, PublicClientApplication } from '@azure/msal-node'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Credential-record scope; the seam requires a lowercase segment owned by this plugin. */
export const CREDENTIAL_SCOPE = 'outlook'

/**
 * Scopes MSAL appends itself. Passing them explicitly is an error, so a
 * deployment that lists `offline_access` keeps it as a statement of intent that
 * this module filters out.
 */
const RESERVED_SCOPES = new Set(['offline_access', 'openid', 'profile'])

/** MSAL error codes that mean "the stored sign-in is no longer usable". */
const AUTH_REQUIRED_CODES = new Set([
  'interaction_required',
  'invalid_grant',
  'no_account_found',
  'no_tokens_found',
  'refresh_token_expired',
  'device_code_expired',
  'unauthorized_client',
])

/** MSAL error codes that mean "the human did not finish, or refused". */
const CANCELLED_CODES = new Set(['device_code_polling_cancelled', 'user_canceled'])

/** MSAL error codes that mean "the challenge ran out of time". */
const EXPIRED_CODES = new Set(['device_code_expired', 'expired_token', 'device_code_polling_timeout'])

/** How long before its stated expiry a cached token is refreshed. */
const TOKEN_REFRESH_MARGIN_MS = 60_000

/**
 * A sign-in or token failure carrying a stable code the caller reports verbatim.
 * @param code - Stable machine code.
 * @param message - Detail for the log.
 * @returns the error to throw.
 */
function authError(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Credential record key for one account slot.
 * @param accountId - Account slot configured for this plugin.
 * @returns the record key.
 */
export function keyFor(accountId) {
  return credentialKey(CREDENTIAL_SCOPE, accountId)
}

/** A login snapshot a plugin page can render. */
export function idleLoginState() {
  return {
    status: 'idle',
    verificationUri: null,
    userCode: null,
    message: null,
    expiresAt: null,
    errorCode: null,
  }
}

/** One Microsoft account's sign-in, shared by the tools and the plugin page. */
export class GraphAuth {
  #credentials
  #accountId
  #settings
  #logger
  #clock
  #onSignedIn
  #onSignedOut
  #client = null
  #cacheBlob = null
  #token = null
  #inflight = null
  #login = null
  #generation = 0

  /**
   * @param options - Construction options.
   * @param options.credentials - The credential service.
   * @param options.accountId - Account slot this instance holds.
   * @param options.settings - Reads `{ clientId, tenant, scopes, loginTimeoutSeconds }` live.
   * @param options.onSignedIn - Called with the signed-in account after a successful login.
   * @param options.onSignedOut - Called after the stored sign-in is removed.
   * @param options.logger - Plugin logger.
   * @param options.clock - Current instant in milliseconds.
   */
  constructor({ credentials, accountId, settings, onSignedIn, onSignedOut, logger, clock = Date.now }) {
    this.#credentials = credentials
    this.#accountId = accountId
    this.#settings = settings
    this.#onSignedIn = onSignedIn
    this.#onSignedOut = onSignedOut
    this.#logger = logger
    this.#clock = clock
  }

  /** Whether an Azure app registration client id is configured. */
  get configured() {
    return this.#settings().clientId !== ''
  }

  /**
   * The signed-in account as the credential record recorded it.
   * @returns the account, or null when the record is absent or carries none.
   */
  async account() {
    const payload = await this.#readPayload()
    return payload?.account ?? null
  }

  /**
   * Whether a stored sign-in exists.
   * @returns true when the credential record is present.
   */
  async authorized() {
    return (await this.#readPayload()) !== null
  }

  /**
   * The scopes the stored sign-in was granted.
   *
   * Nobody else states this: the record holds MSAL's opaque cache and the
   * account block carries no scope list, while the configured scopes say only
   * what the next sign-in would ask for. MSAL's cache is plain JSON, so the
   * granted set is the union over its access tokens.
   *
   * @returns the granted scopes, or an empty list when nothing is stored or the
   * cache carries none.
   */
  async grantedScopes() {
    const payload = await this.#readPayload()
    if (typeof payload?.cache !== 'string' || payload.cache === '') return []
    let cache
    try {
      cache = JSON.parse(payload.cache)
    } catch (error) {
      // A cache this plugin cannot parse has granted nothing it can name. A
      // token request reports the unusable record as `credential_unavailable`.
      this.#logger?.warn?.(`outlook: the stored sign-in cache is not JSON (${String(error?.message ?? error)})`)
      return []
    }
    const granted = new Set()
    for (const entry of Object.values(cache?.AccessToken ?? {})) {
      const target = entry?.target
      if (typeof target !== 'string') continue
      for (const scope of target.split(' ')) {
        if (scope !== '') granted.add(scope)
      }
    }
    return [...granted].sort()
  }

  /**
   * The current login attempt, for a page that polls it.
   * @returns the login snapshot.
   */
  loginState() {
    return this.#login === null ? idleLoginState() : { ...this.#login.state }
  }

  /**
   * Start a device code sign-in.
   *
   * Resolves once Microsoft has answered with a challenge, not when the human
   * finishes: the page renders the code and polls {@link loginState}.
   *
   * @returns the login snapshot, already carrying the challenge.
   */
  async beginLogin() {
    if (this.#login?.state.status === 'waiting') return this.loginState()
    const { clientId, loginTimeoutSeconds } = this.#settings()
    if (clientId === '') {
      this.#login = { request: null, state: { ...idleLoginState(), status: 'failed', errorCode: 'not_configured' } }
      return this.loginState()
    }
    await this.cancelLogin()
    const pca = await this.#application({ fresh: true })
    const state = { ...idleLoginState(), status: 'waiting' }
    const request = {
      scopes: this.#scopes(),
      timeout: loginTimeoutSeconds,
      cancel: false,
      deviceCodeCallback: (response) => {
        state.verificationUri = response.verificationUri ?? null
        state.userCode = response.userCode ?? null
        state.message = response.message ?? null
        state.expiresAt = new Date(this.#clock() + Number(response.expiresIn ?? 0) * 1000).toISOString()
        challenge?.resolve()
      },
    }
    let challenge = null
    const challenged = new Promise((resolve) => {
      challenge = { resolve }
    })
    this.#login = { request, state }
    const settled = pca
      .acquireTokenByDeviceCode(request)
      .then(async (result) => {
        await this.#storeResult(pca, result)
        this.#login = { request, state: { ...state, status: 'succeeded' } }
      })
      .catch((error) => {
        this.#login = { request, state: { ...state, ...failureOf(error) } }
      })
    this.#login.settled = settled
    // Either the challenge arrives, or the attempt fails before one does.
    await Promise.race([challenged, settled])
    return this.loginState()
  }

  /**
   * Ask the running attempt to stop polling.
   * @returns resolution once the attempt has stopped.
   */
  async cancelLogin() {
    const login = this.#login
    if (login === null) return
    if (login.request !== null) login.request.cancel = true
    await login.settled?.catch(() => {})
    if (this.#login === login) this.#login = { request: null, state: { ...login.state, status: 'cancelled', errorCode: null } }
  }

  /**
   * Forget the stored sign-in. Idempotent, and local only: it does not revoke
   * the grant on the Microsoft account.
   * @returns resolution after the record is gone.
   */
  async signOut() {
    await this.cancelLogin()
    // A token refresh already in flight must not persist its cache after this
    // point, or the record the user just removed would come back.
    this.#generation += 1
    this.#client = null
    this.#cacheBlob = null
    this.#token = null
    await this.#credentials.deleteRecord(keyFor(this.#accountId))
    await this.#onSignedOut?.()
  }

  /**
   * A bearer token for one Graph request.
   * @param options - Token options.
   * @param options.force - Acquire a new token even when a cached one is valid.
   * @returns the access token.
   * @throws with code `not_configured`, `auth_required`, or `token_failed`.
   */
  async accessToken({ force = false } = {}) {
    if (this.#settings().clientId === '') {
      throw authError('not_configured', 'outlook: no Azure app registration client id is configured')
    }
    if (!force && this.#token !== null && this.#token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.#clock()) {
      return this.#token.value
    }
    this.#inflight ??= this.#acquire(force).finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  /**
   * Acquire a token silently, persisting whatever the refresh rotated.
   * @param force - Acquire a new token even when a cached one is valid.
   * @returns the access token.
   */
  async #acquire(force) {
    const generation = this.#generation
    const pca = await this.#application({ fresh: false })
    const accounts = await pca.getTokenCache().getAllAccounts()
    if (accounts.length === 0) {
      throw authError('auth_required', 'outlook: no stored sign-in; sign in from the plugin page')
    }
    let result
    try {
      result = await pca.acquireTokenSilent({ account: accounts[0], scopes: this.#scopes(), forceRefresh: force })
    } catch (error) {
      throw this.#tokenFailure(error)
    }
    await this.#persist(pca, generation)
    if (result?.accessToken === undefined || result.accessToken === '') {
      throw authError('auth_required', 'outlook: the stored sign-in produced no access token')
    }
    if (this.#generation !== generation) {
      // Sign-out or a new sign-in landed while the refresh ran. This token
      // belongs to the previous state and must not be handed out.
      throw authError('auth_required', 'outlook: the sign-in changed while a token was acquired')
    }
    this.#token = {
      value: result.accessToken,
      expiresAt: result.expiresOn === null || result.expiresOn === undefined
        ? this.#clock() + TOKEN_REFRESH_MARGIN_MS
        : result.expiresOn.getTime(),
    }
    return this.#token.value
  }

  /**
   * Restate one MSAL failure in this plugin's vocabulary.
   * @param error - The thrown value.
   * @returns the error to throw.
   */
  #tokenFailure(error) {
    /* v8 ignore next -- a non-AuthError from MSAL carries no code to classify */
    const code = typeof error?.errorCode === 'string' ? error.errorCode : ''
    if (error instanceof InteractionRequiredAuthError || AUTH_REQUIRED_CODES.has(code)) {
      return authError('auth_required', `outlook: the stored sign-in is no longer usable (${code || 'interaction_required'})`)
    }
    return authError('token_failed', `outlook: acquiring a token failed (${code || String(error?.message ?? error)})`)
  }

  /**
   * Record a completed sign-in and replace the stored cache.
   * @param pca - The application that ran the flow.
   * @param result - Its authentication result.
   */
  async #storeResult(pca, result) {
    const account = {
      username: result?.account?.username ?? null,
      name: result?.account?.name ?? null,
      tenantId: result?.account?.tenantId ?? null,
      homeAccountId: result?.account?.homeAccountId ?? null,
      checkedAt: new Date(this.#clock()).toISOString(),
    }
    const payload = { cache: pca.getTokenCache().serialize(), account, savedAt: account.checkedAt }
    const generation = this.#generation
    await this.#credentials.modifyRecord(keyFor(this.#accountId), async () => {
      // Sign-out may have started while this write was queued behind the
      // credential lock. Declining leaves the removed record removed.
      if (this.#generation !== generation) return undefined
      return { kind: 'grant', payload }
    })
    // Sign-out may have run while this write was pending; installing the client
    // then would serve tokens from a sign-in the user already removed.
    if (this.#generation !== generation) return
    // A new sign-in supersedes any refresh that was already in flight.
    this.#generation += 1
    // The login application starts from an empty cache, so it only becomes the
    // active client once the flow succeeded and that cache holds the new
    // account. A cancelled or failed attempt must leave the stored sign-in
    // usable.
    this.#client = pca
    this.#cacheBlob = payload.cache
    this.#token = null
    this.#logger?.info?.('outlook: signed in')
    await this.#onSignedIn?.(account)
  }

  /**
   * The MSAL application for this account, with its cache loaded once.
   * @param options - Application options.
   * @param options.fresh - Build an application with an empty cache, for a new sign-in.
   * @returns the application.
   */
  async #application({ fresh }) {
    if (!fresh && this.#client !== null) return this.#client
    const { clientId, tenant } = this.#settings()
    const pca = new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenant}`,
      },
    })
    if (fresh) {
      // A sign-in application is deliberately not the active client yet: it
      // starts from an empty cache, and caching it here would strand the stored
      // sign-in when the attempt is cancelled or fails. A successful flow
      // installs it in `#storeResult`.
      return pca
    }
    const blob = await this.#cache()
    if (blob !== null) {
      try {
        pca.getTokenCache().deserialize(blob)
      } catch (error) {
        throw authError(
          'credential_unavailable',
          `outlook: the stored sign-in cache cannot be read (${String(error?.message ?? error)})`,
        )
      }
    }
    this.#client = pca
    return pca
  }

  /**
   * The stored token cache, read once per process lifetime.
   * @returns the serialized cache, or null when nothing is stored.
   */
  async #cache() {
    if (this.#cacheBlob !== null) return this.#cacheBlob
    const payload = await this.#readPayload()
    this.#cacheBlob = typeof payload?.cache === 'string' && payload.cache !== '' ? payload.cache : null
    return this.#cacheBlob
  }

  /**
   * Write the cache back when MSAL rotated it.
   * @param pca - The application whose cache may have changed.
   */
  async #persist(pca, generation) {
    const cache = pca.getTokenCache()
    if (!cache.hasChanged()) return
    const serialized = cache.serialize()
    const key = keyFor(this.#accountId)
    await this.#credentials.modifyRecord(key, async (current) => {
      // Sign-out or a new sign-in happened while this refresh was running.
      // Leave the current record as it stands rather than recreating a
      // credential the user removed or mixing the old tokens into a new login.
      if (this.#generation !== generation) return undefined
      const payload = payloadOf(current, key)
      if (payload === null) return undefined
      return {
        kind: 'grant',
        payload: {
          cache: serialized,
          account: payload.account ?? null,
          savedAt: new Date(this.#clock()).toISOString(),
        },
      }
    })
    if (this.#generation === generation) this.#cacheBlob = serialized
  }

  /**
   * Read the credential record this plugin owns.
   * @returns the payload, or null when the record is absent.
   * @throws when the record exists but is not one this plugin wrote.
   */
  async #readPayload() {
    return payloadOf(await this.#credentials.readRecord(keyFor(this.#accountId)), keyFor(this.#accountId))
  }

  /**
   * Requested scopes with MSAL's own reserved scopes removed.
   * @returns the scope list.
   */
  #scopes() {
    return this.#settings().scopes.filter((scope) => !RESERVED_SCOPES.has(scope.toLowerCase()))
  }
}

/**
 * Read one stored record's payload.
 *
 * @param record - The record, if any.
 * @param key - The record key, named in the failure.
 * @returns the payload, or null when the record is absent.
 * @throws when the record is not one this plugin wrote.
 */
function payloadOf(record, key) {
  if (record === undefined) return null
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw authError('credential_unavailable', `outlook: credential record "${key}" is not a sign-in record`)
  }
  return record.payload
}

/**
 * Restate a failed device code attempt.
 *
 * Only failures a user can act on keep their own code; everything else is one
 * `login_failed`, because the page can offer nothing more specific than "try
 * again and read the Harness log".
 *
 * @param error - The thrown value.
 * @returns the login fields to store.
 */
function failureOf(error) {
  const code = typeof error?.errorCode === 'string' ? error.errorCode : ''
  if (CANCELLED_CODES.has(code)) return { status: 'cancelled', errorCode: null }
  if (EXPIRED_CODES.has(code)) return { status: 'expired', errorCode: code }
  if (code === 'authorization_declined' || code === 'access_denied') {
    return { status: 'failed', errorCode: 'authorization_declined' }
  }
  return { status: 'failed', errorCode: 'login_failed' }
}
