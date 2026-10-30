# dsh-file-memory

Pure-filesystem memory for DeepSeek Harness: **plain Markdown files, no vectors, no index, no database.**

The plugin exists because two audiences need to be told that memory exists, and neither is served by the other's mechanism:

| Audience | Gap | What this plugin does |
|---|---|---|
| **The model** | Nothing in the prompt says a memory directory exists, so it never looks | Injects one **constant** prompt section naming the directory and how to search it |
| **The user** | Agent-written memory is only editable by going to a terminal | A **Memory panel** that browses, edits, creates, and deletes the same files and folders |

It registers **no agent tool**. Reading, searching, and writing memory all go through the `read`, `write`, `edit`, `glob`, and `grep` tools the harness already provides — enumeration is the model's own `glob` work, and a dedicated memory tool would only re-wrap the filesystem.

## Where memory lives

One directory, default `$DSH_HOME/memory` (`~/.dsh/memory`), read and written by **both** the agent and the panel.

The default is absolute and sits under the Harness home, so it names the same directory whichever directory
launched the harness and whichever profile is running. A **relative `root` is refused at load**. The launch
directory is not the workspace: `dsh web` started from a checkout and the desktop application resolve the same
relative spelling to different directories, and the wrong one presents as an empty memory rather than a
misconfiguration.

Memory under the Harness home lies outside the session workspace, so under the `workspace-write` permission
preset every agent write prompts first. Point `root` at a project directory to keep project memory instead:
writes inside the workspace need no approval, and committing that directory shares it with the team. Keep
personal notes out of a repository other people commit to.

Because the two share one directory, the injected text tells the model the user edits the same files. Without
that, a model would treat every file as its own and overwrite a human's edit.

## Conventions

Worth following, but nothing enforces them — there is no index to go stale:

- One topic per `.md` file, named with the words a future search would use.
- Nested folders are fine; the panel and the walk both recurse.
- No frontmatter is required. A memory file is an ordinary Markdown file.
- **No index file.** Naming and search are the index.

## Install

The bundle installs into a profile:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugins/file-memory
dsh --profile web --dump-config    # should list a `file-memory` row
```

## Configure

Every value lives in the row's `config`; the defaults are documented in [`cordis.patch.yml`](./cordis.patch.yml). Override them from your own patch layer — a matching patch replaces the whole `config` block, so restate every field:

```yaml
- id: file-memory
  name: dsh-file-memory
  config:
    enabled: true
    root: '/srv/shared/memory'
    maxDepth: 5
    maxFileBytes: 1048576
```

A defect — an unknown key, an empty path, a relative path, an out-of-range bound — **fails the load** rather
than falling back. A memory root that silently defaulted would point the panel at a directory you never chose.

## The browser routes

The panel cannot reach this plugin through a Remote namespace: client namespaces come from a fixed list compiled into the web application, and a profile-installed bundle cannot declare one. It therefore uses two exact Fetch routes on the shared API channel:

```
GET  /api/plugin-file-memory/read?op=tree|file[&path=…]
POST /api/plugin-file-memory/mutate?op=write|mkdir|delete[&path=…]
```

There is one configured root, so no request selects a directory. A `root` query parameter is ignored rather
than rejected, so a page cached from an earlier build keeps working.

Both sit under `/api`, so the harness's Host/Origin fence and browser authentication have already run before any handler is reached. This module adds no authentication of its own and **must not be mounted outside that channel**.

Because the channel writes to disk, every request path is untrusted. `src/safe-path.js` canonicalizes the root and the target with `realpath` before comparing them — a lexical check (`path.resolve` plus a prefix test) is not sufficient, because a symlink inside the root resolves outside it while remaining lexically contained. Writes are limited to `.md`, bounded by `maxFileBytes`, and performed atomically through a temporary file beside the destination.

A delete removes one visible `.md` regular file, or a visible folder together with the notes inside it. A folder delete first walks the whole folder and refuses it when it holds anything the tree does not list — a hidden entry, a skipped directory such as `node_modules`, a symbolic link, or a non-markdown file — so one request cannot erase content the panel never showed. The root itself, a hidden path, and a non-markdown file are never removed. The configured root is created at load when it is absent, so a fresh profile can save its first note.

## Mobile

The page reflows against its own column, not the window: a `ResizeObserver` measures the panel and switches to a stacked layout below 720px, so a phone and a squeezed desktop main area behave the same. In the stacked layout the file tree sits above the editor (at most 42vh tall) instead of beside it, and the tree's folder, file, and delete controls grow to touch-sized targets. Opening a file collapses the tree so the editor gets the rest of the height; the header's **Files** button (**文件** in Chinese) brings it back. The editor switches to a 16px font so iOS does not zoom on focus, the toolbar wraps with the path on its own line, and the page pads for the home-indicator safe area. Above 720px the original two-pane layout is unchanged.

## Test

```bash
node --test "tests/*.test.mjs"
```

The suite covers path containment (including symlink escapes, which need a real filesystem), the two routes end to end, config validation, the injected text, and the client bundle's registration contract.

## Known Limitations and Deferred Work

- **Lexical search cannot match a paraphrase.** A note reading "token refresh is racy" will not match a search for "login concurrency bug". The injected text asks the model to retry with synonyms, which is the only mitigation available without embeddings. This is the inherent cost of the design, not a defect to be fixed here.
- **The prompt section tells the model that memory exists; it cannot make the model consult it.** Whether the model searches before answering is a property of the wording, and the wording is the only lever.
- **No concurrent-write protection.** The agent and the panel can write the same file; the later write wins. A save that compared modification times before writing would surface the conflict.
- **No rename or move in the panel.** Deferred: both need tree recomputation and conflict handling.
- **A folder holding non-memory content cannot be deleted from the panel.** Removing it would erase files the tree never showed, so the route refuses it with `unlisted_content`; remove that content outside the panel first.
- **The panel does not observe the agent's writes.** It fetches on open and on Refresh. A `ctx.fs.watch` subscription pushing changes would remove the manual step.
- **Memory has no version control of its own.** A committed memory directory recovers a mistake through git; an uncommitted or out-of-workspace one does not, and the panel has no undo.
- **The panel talks to `node:fs` directly rather than through `ctx.fs`.** Deliberate: a configured root may sit outside the workspace, where the workspace-scoped filesystem service cannot reach. Routing memory through it would silently make an out-of-workspace root unusable; supporting that properly needs an explicit provider choice.
- **The agent and the user can overwrite each other.** One shared directory means no ownership boundary. The injected text asks the model to read before overwriting, and the panel confirms destructive actions, but nothing enforces it.
- **No size guard on the tree response.** A root with very many files returns them all; the depth bound limits nesting, not breadth.
