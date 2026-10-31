# dsh-file-memory

Pure-filesystem memory for DeepSeek Harness: **plain Markdown files, no vectors, no index, no database.**

It serves two audiences: the model (a **constant** prompt section naming the directory and how to search it) and the user (a **Memory panel** that browses, edits, creates, and deletes the same files). It registers **no agent tool** — reading and writing go through the `read`, `write`, `edit`, `glob`, and `grep` tools the harness already provides.

## Where memory lives

One directory, default `$DSH_HOME/memory` (`~/.dsh/memory`), read and written by both the agent and the panel.

The default is absolute and under the Harness home, so it names the same directory whichever directory launched the harness and whichever profile runs. A **relative `root` is refused at load**: the launch directory is not the workspace, and the wrong resolution presents as an empty memory rather than a misconfiguration.

Memory under the Harness home lies outside the session workspace, so under the `workspace-write` preset every agent write prompts first. Point `root` at a project directory to keep project memory instead — writes inside the workspace need no approval. Keep personal notes out of a repository others commit to.

Because both sides share one directory, the injected text tells the model that the user edits the same files; without that it would treat every file as its own and overwrite a human's edit.

## Conventions

Not enforced, and nothing can go stale: one topic per `.md` file named with the words a future search would use, nested folders fine, no frontmatter, **no index file**.

## Install and configure

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugins/file-memory
dsh --profile web --dump-config    # should list a `file-memory` row
```

Every value lives in the row's `config`; a matching patch replaces the whole block, so restate every field:

```yaml
- id: file-memory
  name: dsh-file-memory
  config:
    enabled: true
    root: '/srv/shared/memory'
    maxDepth: 5
    maxFileBytes: 1048576
```

A defect — unknown key, empty or relative path, out-of-range bound — **fails the load** rather than falling back.

## Browser routes

```
GET  /api/plugin-file-memory/read?op=tree|file[&path=…]
POST /api/plugin-file-memory/mutate?op=write|mkdir|delete[&path=…]
```

The panel cannot use a Remote namespace (client namespaces come from a list compiled into the web app), so it uses these two exact routes on the shared `/api` channel, where the harness's Host/Origin fence and browser authentication have already run. There is one configured root, so no request selects a directory; a `root` query parameter is ignored rather than rejected.

Every request path is untrusted. `src/safe-path.js` canonicalizes root and target with `realpath` before comparing — a lexical check is not enough, because a symlink inside the root resolves outside it while staying lexically contained. Writes are limited to `.md`, bounded by `maxFileBytes`, and performed atomically through a temporary file beside the destination.

A delete removes one visible `.md` file, or a visible folder with the notes inside it; a folder delete first walks the whole folder and refuses it when it holds anything the tree does not list (a hidden entry, `node_modules`, a symlink, a non-markdown file), so one request cannot erase content the panel never showed. The root, a hidden path, and a non-markdown file are never removed. The root is created at load when absent.

## Test

```bash
node --test "tests/*.test.mjs"
```

Covers path containment (including symlink escapes), both routes end to end, config validation, the injected text, and the client bundle's registration contract.

## Limitations

- **Lexical search cannot match a paraphrase**: "token refresh is racy" will not match "login concurrency bug". The injected text asks the model to retry with synonyms — the only mitigation without embeddings.
- **The prompt section tells the model memory exists; it cannot make the model consult it.** Whether it searches first is a property of the wording.
- **No concurrent-write protection**: the agent and the panel can write the same file, and the later write wins. No rename or move in the panel; the panel does not observe the agent's writes (it fetches on open and on Refresh); there is no undo and no version control of its own.
- **A folder holding non-memory content cannot be deleted from the panel** — removing it would erase files the tree never showed, so the route refuses it with `unlisted_content`.
- **The panel talks to `node:fs` directly**, not `ctx.fs`: a configured root may sit outside the workspace, where the workspace-scoped filesystem service cannot reach.
- **No size guard on the tree response**: the depth bound limits nesting, not breadth.
