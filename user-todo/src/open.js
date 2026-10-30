/**
 * Open the list's domain and wrap it in the store the panel and the tools share.
 *
 * A store that cannot finish opening must release the domain: the facility
 * reserves an open name, so a leaked handle fails every later mount with
 * `already-open` until the process restarts.
 *
 * @module dsh-user-todo/src/open
 */

import { userTodoDomain } from './domain.js'
import { TodoStore } from './store.js'

/**
 * @param facility - the mounted storage domain facility (`ctx.storageDomain`).
 * @param options - configured bounds, list cap, and the deployment zone.
 * @returns the open store.
 */
export async function openTodoStore(facility, options) {
  return new TodoStore(await facility.open(userTodoDomain), options)
}
