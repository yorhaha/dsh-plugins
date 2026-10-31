/**
 * Image download for a captured note.
 *
 * The image CDN is a different host from the API and does not carry the
 * request-signature budget; downloads therefore have their own small
 * concurrency limit and byte ceiling. A failed image never fails the capture:
 * the note keeps its remote URL and the media row simply has no local path.
 *
 * @module dsh-xiaohongshu/src/media
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/** Content types the plugin knows how to name. */
const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
}

/** Default browser identity for CDN requests. */
const MEDIA_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

/**
 * Pick a safe file extension for one image.
 * @param url - remote URL.
 * @param contentType - response content type.
 * @returns the extension including the dot.
 */
function extensionOf(url, contentType) {
  const normalized = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (EXTENSIONS[normalized] !== undefined) return EXTENSIONS[normalized]
  const fromUrl = extname(new URL(url).pathname).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'].includes(fromUrl)) {
    return fromUrl === '.jpeg' ? '.jpg' : fromUrl
  }
  return '.jpg'
}

/**
 * Download one image with a byte ceiling.
 * @param url - remote image URL.
 * @param destinationBase - path without extension.
 * @param options - limits and logger.
 * @returns `{ localPath, bytes }`, or null when the download was refused or failed.
 */
async function downloadOne(url, destinationBase, { maxBytes, timeoutMs, logger }) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const response = await fetch(parsed, {
    headers: {
      'user-agent': MEDIA_USER_AGENT,
      referer: 'https://www.xiaohongshu.com/',
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    logger?.warn?.(`xiaohongshu: image ${response.status} from ${parsed.host}`)
    return null
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    logger?.warn?.(`xiaohongshu: image rejected, ${declared} bytes over the limit`)
    return null
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return null
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      logger?.warn?.('xiaohongshu: image rejected while streaming over the byte limit')
      return null
    }
    chunks.push(value)
  }
  const extension = extensionOf(url, response.headers.get('content-type'))
  const localPath = `${destinationBase}${extension}`
  mkdirSync(join(destinationBase, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(localPath, Buffer.concat(chunks), { mode: 0o600 })
  return { localPath, bytes: total }
}

/**
 * Download a note's images with bounded concurrency.
 *
 * @param noteId - the note the images belong to.
 * @param images - `{ url, width, height }` entries from the mapper.
 * @param options - media root, limits, and logger.
 * @returns a new image list with `local_path` and `bytes` when downloaded.
 */
export async function downloadImages(noteId, images, options) {
  const safeId = String(noteId).replace(/[^A-Za-z0-9_-]/g, '_')
  const directory = join(options.mediaRoot, safeId)
  const results = images.map((image) => ({ ...image, local_path: null, bytes: null }))
  let next = 0
  const workers = Array.from({ length: Math.min(options.concurrency, results.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= results.length) return
      const image = results[index]
      try {
        const downloaded = await downloadOne(
          image.url,
          join(directory, String(index).padStart(2, '0')),
          options,
        )
        if (downloaded !== null) {
          image.local_path = downloaded.localPath
          image.bytes = downloaded.bytes
        }
      } catch (error) {
        options.logger?.warn?.(`xiaohongshu: image download failed: ${String(error)}`)
      }
    }
  })
  await Promise.all(workers)
  return results
}
