/**
 * The text this plugin injects to tell the model that memory exists.
 *
 * Three properties are deliberate and must survive edits:
 *
 * 1. **It is constant.** The value depends only on the configured root, which is
 *    fixed at load, so the assembled prompt is byte-identical across turns and
 *    does not invalidate the prefix cache.
 * 2. **It lists no memories.** It says where memory lives and how to search it;
 *    enumerating entries is the model's own `glob`/`grep` work. An injected
 *    index would go stale and grow without bound.
 * 3. **It states that the user writes these same files.** The model and the user
 *    share one directory, so a note may have been written by either. A model that
 *    assumed every file was its own would silently overwrite a human's edit.
 *
 * The retry instruction is not padding. Lexical search does not match a
 * paraphrase, so a model that tries one wording and gives up will answer from
 * priors while sounding confident — the failure this design most needs to
 * avoid.
 *
 * @module dsh-file-memory/guidance
 */

/**
 * Render the memory guidance for one root.
 * @param root - absolute memory directory.
 * @returns the prompt section text.
 */
export function memoryGuidance(root) {
  return [
    `Durable memory lives in \`${root}\` as Markdown; you can read and write it with your ordinary file tools.`,
    'Both you and the user can read and write it. Read a file before modifying it, and keep edits additive rather than',
    'discarding context you did not write.',
    '',
    'Before assuming a convention or repeating a past investigation, search memory first:',
    `\`grep -ri "<topic>" ${root}\` to find by content, or \`glob '${root}/**/*.md'\` to list`,
    'everything. Search returns exact words only, so if the first wording misses, retry with two or three',
    'synonyms before concluding that nothing is recorded — a single failed search is not evidence that',
    'memory is empty.',
    '',
    'When you settle on something worth keeping long-term for the user and using in other contexts, edit existing files or add files as needed, and name them with the words a future search would use.',
    'Do not maintain an index file; naming and search are the index.',
  ].join('\n')
}
