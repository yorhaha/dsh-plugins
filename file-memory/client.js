/**
 * Memory panel, browser half: the **Memory** entry in the sidebar and the page
 * it opens in the main column.
 *
 * The page browses, edits, creates, and deletes the Markdown files and the
 * folders holding them. It reaches the Host through the two exact
 * Fetch routes the Host half registers, because a profile-installed bundle
 * cannot declare a Remote namespace — client namespaces come from a fixed list
 * compiled into the web application.
 *
 * A plain-JavaScript plugin gets React from the browser module table and must
 * not load any `@deepseek-ai/dsh-client-*` package as a module. Styling is
 * therefore limited to `--dsw-alias-*` theme tokens, which degrade in
 * appearance rather than breaking if a token is renamed.
 *
 * @module dsh-file-memory/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-file-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'fileMemory'
    /**
     * The id shared by the sidebar entry and the panel it opens. The sidebar
     * selects the panel by this id, so the two registrations must agree.
     */
    const PANEL_ID = 'memory'
    const READ_PATH = '/api/plugin-file-memory/read'
    const MUTATE_PATH = '/api/plugin-file-memory/mutate'

    const en = {
      panelTitle: 'Memory',
      files: 'Files',
      hideFiles: 'Hide list',
      empty: 'No memory files yet.',
      emptyHint: 'Create one below, or ask the agent to record something.',
      loading: 'Loading…',
      unreadable: '{count} folder(s) could not be read and are not shown.',
      noSelection: 'Select a file to read it.',
      noSelectionHint: 'Memory is one topic per file. Name a file with the words a future search would use.',
      placeholder: 'Write Markdown here.',
      modified: 'Unsaved changes',
      saved: 'Saved',
      save: 'Save',
      revert: 'Revert',
      delete: 'Delete',
      deleteFolder: 'Delete folder',
      deleteFolderNamed: 'Delete folder {path}',
      newFile: 'New file',
      newFolder: 'New folder',
      refresh: 'Refresh',
      cancel: 'Cancel',
      create: 'Create',
      confirmDelete: 'Delete {path}? This cannot be undone.',
      confirmDeleteFolder: 'Delete folder {path} and every note inside it? This cannot be undone.',
      confirmDiscard: 'You have unsaved changes. Discard them?',
      promptFile: 'File name, ending in .md',
      promptFolder: 'Folder name',
      loadFailed: 'Could not load memory: {code}',
    }
    const zh = {
      panelTitle: '记忆',
      files: '文件',
      hideFiles: '收起列表',
      empty: '还没有记忆文件。',
      emptyHint: '在下面新建一条，或让 Agent 记录一些内容。',
      loading: '加载中…',
      unreadable: '有 {count} 个文件夹无法读取，未显示。',
      noSelection: '选择一个文件以查看内容。',
      noSelectionHint: '记忆是一主题一文件。文件名请用未来搜索时会想到的词。',
      placeholder: '在这里写 Markdown。',
      modified: '有未保存的修改',
      saved: '已保存',
      save: '保存',
      revert: '还原',
      delete: '删除',
      deleteFolder: '删除文件夹',
      deleteFolderNamed: '删除文件夹 {path}',
      newFile: '新建文件',
      newFolder: '新建文件夹',
      refresh: '刷新',
      cancel: '取消',
      create: '创建',
      confirmDelete: '确定删除 {path}？此操作无法撤销。',
      confirmDeleteFolder: '确定删除文件夹 {path} 及其中的所有记忆？此操作无法撤销。',
      confirmDiscard: '有未保存的修改，确定放弃吗？',
      promptFile: '文件名，以 .md 结尾',
      promptFolder: '文件夹名',
      loadFailed: '无法加载记忆：{code}',
    }

    /** Failure codes the Host can return, mapped to readable text. */
    const ERROR_TEXT = {
      unknown_root: 'That memory location is not configured.',
      unknown_op: 'Unsupported operation.',
      outside_root: 'That path is outside the memory folder.',
      wrong_extension: 'Only .md files are supported.',
      wrong_kind: 'That operation does not apply here.',
      unlisted_content: 'The folder holds items this page does not list. Remove them outside the panel first.',
      too_large: 'The file is larger than the allowed size.',
      not_found: 'The file no longer exists.',
      denied: 'The filesystem refused access.',
      invalid_body: 'The request was malformed.',
      invalid_encoding: 'The file is not valid UTF-8 text.',
      internal: 'Something went wrong. See the Harness log for details.',
    }

    /** The client context, captured by `apply` so components can reach services. */
    const ctxRef = { current: null }

    /**
     * Namespace-bound translate, assigned by `apply`.
     *
     * The sidebar re-resolves a list entry's `label` by calling it, so this must
     * read the active locale at CALL time rather than at registration time —
     * otherwise the entry keeps the language it was registered in.
     */
    let translate = key => key

    /** Read the active locale id, tolerating any snapshot shape change. */
    function activeLocale(service) {
      try {
        const snapshot = service.getSnapshot()
        return snapshot?.active ?? 'en'
      } catch {
        return 'en'
      }
    }

    /** Failure codes the Host can return, in the panel's second language. */
    const ERROR_TEXT_ZH = {
      unknown_root: '该记忆位置未配置。',
      unknown_op: '不支持的操作。',
      outside_root: '该路径在记忆文件夹之外。',
      wrong_extension: '只支持 .md 文件。',
      wrong_kind: '该操作不适用于此目标。',
      unlisted_content: '该文件夹包含此页面未列出的内容，请先在面板外删除。',
      too_large: '文件超过允许的大小。',
      not_found: '文件已不存在。',
      denied: '文件系统拒绝访问。',
      invalid_body: '请求格式不正确。',
      invalid_encoding: '该文件不是有效的 UTF-8 文本。',
      internal: '出错了，详情见 Harness 日志。',
    }

    /** One JSON request to a Host route. */
    async function call(path, query, init) {
      const url = new URL(path, window.location.origin)
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, value)
      }
      const response = await fetch(url, { credentials: 'same-origin', ...init })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('internal')
      }
      if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? 'internal')
      return payload
    }

    /** Replace `{name}` placeholders in a locale string. */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ))
    }

    /**
     * Below this panel width the two-pane layout (a fixed 260px file tree beside
     * the editor) stops leaving the editor room, so the page stacks instead.
     */
    const NARROW_WIDTH = 720

    /**
     * Track one element's own width. The main column can be far narrower than the
     * window (an open sidebar, a split view, a phone), and inline styles cannot
     * carry a media query, so the page measures its own box and reflows from it.
     *
     * @param ref - the element to measure.
     * @returns the element's content width, starting from the window width.
     */
    function useElementWidth(ref) {
      const [width, setWidth] = useState(() => (
        typeof window === 'undefined' ? 1200 : window.innerWidth
      ))
      useEffect(() => {
        const element = ref.current
        if (element === null) return undefined
        const measure = () => {
          const next = element.getBoundingClientRect().width
          if (next > 0) setWidth(next)
        }
        measure()
        if (typeof ResizeObserver === 'undefined') {
          window.addEventListener('resize', measure)
          return () => window.removeEventListener('resize', measure)
        }
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [ref])
      return width
    }

    /** The panel's decorative sidebar glyph, sized by the sidebar. */
    function MemoryIcon(props) {
      const size = props.size ?? 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false,
      },
      h('path', {
        d: 'M7 3h6.5L18 7.5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M13.5 3v5H18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M8.5 12.5h7M8.5 16h4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round',
      }))
    }

    /** The delete-folder control's glyph. */
    function TrashIcon(props) {
      const size = props.size ?? 12
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false,
      },
      h('path', {
        d: 'M4 7h16M10 4h4M6.5 7l.9 13h9.2l.9-13M10 11v6M14 11v6',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    const styles = {
      page: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        color: 'var(--dsw-alias-text-primary, inherit)',
      },
      header: {
        padding: '12px 18px', borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.25))',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      sidebar: {
        width: 260, flexShrink: 0, overflowY: 'auto', padding: '10px 6px 10px 10px',
        borderRight: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.25))',
      },
      main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      row: (active, isDir, touch = false) => ({
        display: 'flex', alignItems: 'center', gap: touch ? 6 : 4, width: '100%', textAlign: 'left',
        appearance: 'none', border: 'none', cursor: 'pointer', fontSize: touch ? 14 : 12.5,
        padding: touch ? '7px 8px' : '3px 6px',
        borderRadius: touch ? 7 : 5, background: active ? 'var(--dsw-alias-surface-raised, rgba(128,128,128,.18))' : 'transparent',
        color: 'inherit', fontWeight: isDir ? 600 : 400, opacity: isDir ? 0.9 : 1,
      }),
      twisty: { width: 12, flexShrink: 0, opacity: 0.6, fontSize: 10 },
      name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      toolbar: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.25))',
      },
      button: (primary, disabled) => ({
        appearance: 'none', fontSize: 12, padding: '5px 11px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3))',
        background: primary ? 'var(--dsw-alias-accent-solid, #2f6f6b)' : 'transparent',
        color: primary ? 'var(--dsw-alias-text-on-accent, #fff)' : 'inherit',
        opacity: disabled ? 0.45 : 1,
      }),
      path: { fontSize: 12, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
      editor: {
        flex: 1, minHeight: 0, width: '100%', resize: 'none', border: 'none', outline: 'none',
        padding: '14px 16px', fontSize: 13, lineHeight: 1.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: 'transparent', color: 'inherit', boxSizing: 'border-box',
      },
      notice: { padding: '18px', fontSize: 13, opacity: 0.7 },
      noticeHint: { fontSize: 12, opacity: 0.75, marginTop: 6 },
      error: {
        margin: '10px 14px', padding: '8px 10px', borderRadius: 6, fontSize: 12,
        border: '1px solid var(--dsw-alias-border-subtle, rgba(200,80,80,.5))',
        background: 'var(--dsw-alias-surface-raised, rgba(200,80,80,.12))',
      },
      dirToolbar: { display: 'flex', gap: 6, padding: '0 10px 8px' },
      folderRow: { display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4 },
      folderDelete: (disabled, touch = false) => ({
        appearance: 'none', border: 'none', background: 'transparent', color: 'inherit',
        padding: touch ? '7px 6px' : '3px 4px', borderRadius: 4, display: 'flex', flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.2 : 0.45,
      }),
      smallButton: {
        appearance: 'none', fontSize: 11.5, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.3))',
        background: 'transparent', color: 'inherit', opacity: 0.85,
      },
    }

    /** One directory row, recursively rendering its children while expanded. */
    function TreeNode(props) {
      const { node, depth, selected, onSelect, expanded, onToggle, onDeleteFolder, busy, t, touch } = props
      const pad = { paddingLeft: 6 + depth * (touch ? 14 : 12) }
      const twisty = touch ? { ...styles.twisty, width: 16, fontSize: 12 } : styles.twisty
      if (node.type === 'file') {
        return h('button', {
          type: 'button', style: { ...styles.row(selected === node.path, false, touch), ...pad },
          onClick: () => onSelect(node.path), title: node.path,
        }, h('span', { style: twisty }), h('span', { style: styles.name }, node.name))
      }
      const open = expanded.has(node.path)
      const children = node.children
      return h('div', null,
        h('div', { style: styles.folderRow },
          h('button', {
            type: 'button',
            style: { ...styles.row(false, true, touch), ...pad, flex: 1, width: 'auto', minWidth: 0 },
            onClick: () => onToggle(node.path),
            title: node.path,
            'aria-expanded': open,
          },
          h('span', { style: twisty }, children.length === 0 ? '·' : (open ? '▾' : '▸')),
          h('span', { style: styles.name }, node.name)),
          h('button', {
            type: 'button',
            style: styles.folderDelete(busy, touch),
            disabled: busy,
            title: t('deleteFolder'),
            'aria-label': fill(t('deleteFolderNamed'), { path: node.path }),
            onClick: () => onDeleteFolder(node.path),
          }, h(TrashIcon, { size: touch ? 15 : 12 }))),
        open
          ? children.map(child => h(TreeNode, {
            key: child.path, node: child, depth: depth + 1, selected, onSelect, expanded, onToggle,
            onDeleteFolder, busy, t, touch,
          }))
          : null)
    }

    /** The Memory page. */
    function MemoryPage() {
      const [locale, setLocale] = useState('en')
      const [tree, setTree] = useState(null)
      const [unreadable, setUnreadable] = useState(0)
      const [selected, setSelected] = useState(null)
      const [text, setText] = useState('')
      const [savedText, setSavedText] = useState('')
      const [expanded, setExpanded] = useState(() => new Set())
      // The failure code, not translated text: rendering resolves it, so a
      // locale change re-reads the message instead of freezing the old one.
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      // `showTree` is the reader's toggle on a narrow page; wide pages always
      // show it. The page measures its own column so a squeezed desktop main
      // area stacks exactly like a phone.
      const [showTree, setShowTree] = useState(true)
      const pageRef = useRef(null)
      const width = useElementWidth(pageRef)
      const narrow = width < NARROW_WIDTH
      const narrowRef = useRef(narrow)
      narrowRef.current = narrow
      const dirty = selected !== null && text !== savedText
      const dirtyRef = useRef(false)
      dirtyRef.current = dirty

      const t = useCallback((key, values) => {
        const template = translate(key)
        return values === undefined ? template : fill(template, values)
      }, [locale])

      const refresh = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const payload = await call(READ_PATH, { op: 'tree' })
          setTree(payload.children ?? [])
          setUnreadable(payload.unreadable ?? 0)
        } catch (cause) {
          setError(cause.message)
          setTree([])
        } finally {
          setBusy(false)
        }
      }, [])

      const openFile = useCallback(async (path) => {
        if (dirtyRef.current && !window.confirm(t('confirmDiscard'))) return
        setBusy(true)
        setError(null)
        try {
          const payload = await call(READ_PATH, { op: 'file', path })
          setSelected(payload.path)
          setText(payload.text)
          setSavedText(payload.text)
          // On a stacked page the tree yields its height to the editor as soon
          // as a file is open; the header's Files control brings it back.
          if (narrowRef.current) setShowTree(false)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [t])

      const save = useCallback(async () => {
        if (selected === null) return
        setBusy(true)
        setError(null)
        try {
          await call(MUTATE_PATH, { op: 'write', path: selected },
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
          setSavedText(text)
          await refresh()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [selected, text, refresh])

      const remove = useCallback(async () => {
        if (selected === null) return
        if (!window.confirm(t('confirmDelete', { path: selected }))) return
        setBusy(true)
        setError(null)
        try {
          await call(MUTATE_PATH, { op: 'delete', path: selected },
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setSelected(null)
          setText('')
          setSavedText('')
          await refresh()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [selected, refresh, t])

      const removeFolder = useCallback(async (path) => {
        if (!window.confirm(t('confirmDeleteFolder', { path }))) return
        setBusy(true)
        setError(null)
        try {
          await call(MUTATE_PATH, { op: 'delete', path },
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (selected !== null && (selected === path || selected.startsWith(`${path}/`))) {
            setSelected(null)
            setText('')
            setSavedText('')
          }
          // Drop expansion state for the removed subtree, so a folder created
          // later under the same name does not inherit a stale open state.
          setExpanded((previous) => {
            const next = new Set()
            for (const key of previous) {
              if (key !== path && !key.startsWith(`${path}/`)) next.add(key)
            }
            return next
          })
          await refresh()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [selected, refresh, t])

      const createInto = useCallback(async (parentPath, kind) => {
        const label = kind === 'file' ? t('promptFile') : t('promptFolder')
        const raw = window.prompt(label, '')
        if (raw === null) return
        const name = raw.trim().replace(/^\/+|\/+$/g, '')
        if (name === '') return
        const path = parentPath === '' ? name : `${parentPath}/${name}`
        setBusy(true)
        setError(null)
        try {
          if (kind === 'file') {
            if (!name.toLowerCase().endsWith('.md')) throw new Error('wrong_extension')
            await call(MUTATE_PATH, { op: 'write', path },
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) })
          } else {
            await call(MUTATE_PATH, { op: 'mkdir', path },
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            setExpanded(previous => new Set(previous).add(parentPath))
          }
          await refresh()
          if (kind === 'file') await openFile(path)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [refresh, openFile, t])

      const toggle = useCallback((path) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
      }, [])

      // Follow the host's locale, so the panel reads in the user's language.
      useEffect(() => {
        const service = ctxRef.current?.locale
        if (service === undefined) return undefined
        const read = () => setLocale(activeLocale(service))
        read()
        return service.subscribe(read)
      }, [])

      // `refresh` is stable, so this runs once on mount.
      useEffect(() => { void refresh() }, [refresh])

      useEffect(() => {
        const onKey = (event) => {
          const meta = event.metaKey || event.ctrlKey
          if (meta && event.key.toLowerCase() === 's' && dirtyRef.current) {
            event.preventDefault()
            void save()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [save])

      // The stacked page shows the tree until a file is open, and the header's
      // toggle gains the rest of the height back for the editor.
      const treeVisible = !narrow || selected === null || showTree
      const pageStyle = narrow
        ? { ...styles.page, boxSizing: 'border-box', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }
        : styles.page
      const headerStyle = narrow
        ? { ...styles.header, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' }
        : styles.header
      const titleStyle = narrow ? { ...styles.title, flex: '1 1 auto', minWidth: 0, fontSize: 16 } : styles.title
      const bodyStyle = narrow ? { ...styles.body, flexDirection: 'column' } : styles.body
      const sidebarStyle = narrow
        ? {
            ...styles.sidebar, width: '100%', maxHeight: '42vh', flexShrink: 0, boxSizing: 'border-box',
            borderRight: 'none',
            borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.25))',
            padding: '8px 6px 8px 8px',
          }
        : styles.sidebar
      const dirToolbarStyle = narrow
        ? { ...styles.dirToolbar, flexWrap: 'wrap', gap: 6, padding: '0 8px 8px' }
        : styles.dirToolbar
      const smallButtonStyle = narrow
        ? { ...styles.smallButton, padding: '6px 10px', fontSize: 12.5, minHeight: 32 }
        : styles.smallButton
      const toolbarStyle = narrow
        ? { ...styles.toolbar, flexWrap: 'wrap', gap: 6, rowGap: 6, padding: '8px 12px' }
        : styles.toolbar
      const pathStyle = narrow ? { ...styles.path, flex: '1 1 100%' } : styles.path
      const editorStyle = narrow
        ? { ...styles.editor, padding: '12px', fontSize: 16, lineHeight: 1.55 }
        : styles.editor
      const actionStyle = (primary, disabled) => (narrow
        ? { ...styles.button(primary, disabled), padding: '7px 14px', fontSize: 13, minHeight: 34 }
        : styles.button(primary, disabled))

      return h('div', { ref: pageRef, style: pageStyle },
        h('div', { style: headerStyle },
          h('h2', { style: titleStyle }, t('panelTitle')),
          narrow && selected !== null
            ? h('button', {
                type: 'button', style: smallButtonStyle, disabled: busy,
                'aria-expanded': treeVisible,
                onClick: () => setShowTree((shown) => !shown),
              }, treeVisible ? t('hideFiles') : t('files'))
            : null),
        error !== null
          ? h('div', { style: styles.error },
            locale === 'zh' ? (ERROR_TEXT_ZH[error] ?? t('loadFailed', { code: error }))
              : (ERROR_TEXT[error] ?? t('loadFailed', { code: error })))
          : null,
        h('div', { style: bodyStyle },
          treeVisible
            ? h('div', { style: sidebarStyle },
              h('div', { style: dirToolbarStyle },
                h('button', {
                  type: 'button', style: smallButtonStyle, disabled: busy,
                  onClick: () => void createInto('', 'file'),
                }, t('newFile')),
                h('button', {
                  type: 'button', style: smallButtonStyle, disabled: busy,
                  onClick: () => void createInto('', 'folder'),
                }, t('newFolder')),
                h('button', {
                  type: 'button', style: smallButtonStyle, disabled: busy,
                  onClick: () => void refresh(),
                }, t('refresh'))),
              tree === null
                ? h('div', { style: styles.notice }, t('loading'))
                : tree.length === 0
                  ? h('div', { style: styles.notice }, t('empty'), h('div', { style: styles.noticeHint }, t('emptyHint')))
                  : tree.map(node => h(TreeNode, {
                    key: node.path, node, depth: 0, selected, onSelect: path => void openFile(path),
                    expanded, onToggle: toggle, onDeleteFolder: path => void removeFolder(path), busy, t,
                    touch: narrow,
                  })),
              unreadable > 0
                ? h('div', { style: { ...styles.noticeHint, padding: '8px 8px 0' } }, t('unreadable', { count: unreadable }))
                : null)
            : null,
          h('div', { style: styles.main },
            selected === null
              ? h('div', { style: styles.notice }, t('noSelection'), h('div', { style: styles.noticeHint }, t('noSelectionHint')))
              : h(React.Fragment, null,
                h('div', { style: toolbarStyle },
                  h('span', { style: pathStyle, title: selected }, selected),
                  dirty ? h('span', { style: { fontSize: narrow ? 12 : 11, opacity: 0.6 } }, t('modified')) : null,
                  h('button', {
                    type: 'button', style: actionStyle(true, busy || !dirty), disabled: busy || !dirty,
                    onClick: () => void save(),
                  }, t('save')),
                  h('button', {
                    type: 'button', style: actionStyle(false, busy || !dirty), disabled: busy || !dirty,
                    onClick: () => setText(savedText),
                  }, t('revert')),
                  h('button', {
                    type: 'button', style: actionStyle(false, busy), disabled: busy,
                    onClick: () => void remove(),
                  }, t('delete'))),
                h('textarea', {
                  style: editorStyle, value: text, spellCheck: false, placeholder: t('placeholder'),
                  onChange: event => setText(event.target.value),
                })))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctxRef.current = ctx
        translate = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'file-memory: dictionaries')
        // `label` is what the sidebar shows; without it the entry falls back to
        // the panel id. It is a function so a language change re-resolves it
        // without re-registering, and it names a FLAT key: the locale service
        // indexes dictionaries by exact key and does not expand `a.b`.
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS,
          label: () => translate('panelTitle'),
        }, MemoryIcon)), 'file-memory: sidebar entry')
        ctx.effect(() => ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MemoryPage)
        }), 'file-memory: page')
      },
    }
  },
})
