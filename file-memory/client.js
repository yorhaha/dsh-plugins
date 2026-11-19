/**
 * Memory panel, browser half: the **Memory** entry in the sidebar and the page
 * it opens in the main column.
 *
 * The page browses, edits, previews, creates, and deletes the Markdown files
 * and the folders holding them. It reaches the Host through the two exact
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
    const { useCallback, useEffect, useMemo, useRef, useState } = React

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
      panelSubtitle: 'Long-term Markdown notes shared with the assistant',
      files: 'Files',
      hideFiles: 'Hide list',
      searchPlaceholder: 'Filter files…',
      clearSearch: 'Clear filter',
      noMatches: 'No files match "{query}".',
      empty: 'No memory files yet.',
      emptyHint: 'Create a note below, or ask the assistant to save one.',
      loading: 'Loading…',
      unreadable: '{count} folder(s) could not be read and are hidden.',
      noSelection: 'Select a file to read or edit.',
      noSelectionHint: 'Keep one topic per file, and use searchable keywords in file names.',
      placeholder: 'Write Markdown here…',
      previewEmpty: 'Nothing to preview yet.',
      modeEdit: 'Edit',
      modePreview: 'Preview',
      modified: 'Unsaved',
      saved: 'Saved',
      save: 'Save',
      saving: 'Saving…',
      revert: 'Revert',
      delete: 'Delete',
      deleteFolder: 'Delete folder',
      deleteFolderNamed: 'Delete folder {path}',
      newFile: 'New file',
      newFileInFolder: 'New file in {path}',
      newFolder: 'New folder',
      refresh: 'Refresh',
      cancel: 'Cancel',
      create: 'Create',
      discard: 'Discard',
      saveAndSwitch: 'Save & switch',
      confirmDelete: 'Delete {path}? This cannot be undone.',
      confirmDeleteFolder: 'Delete folder {path} and all notes inside? This cannot be undone.',
      confirmDiscard: 'You have unsaved changes in {path}.',
      promptFile: 'File name (ending in .md)',
      promptFolder: 'Folder name',
      createTargetRoot: 'Root',
      statsSummary: '{lines} lines · {chars} chars',
      shortcutHint: '⌘S / Ctrl+S to save',
      loadFailed: 'Failed to load memory: {code}',
    }
    const zh = {
      panelTitle: '记忆',
      panelSubtitle: '与助手共享的长期 Markdown 笔记',
      files: '文件列表',
      hideFiles: '收起列表',
      searchPlaceholder: '筛选文件…',
      clearSearch: '清除筛选',
      noMatches: '未找到匹配「{query}」的文件。',
      empty: '暂无记忆文件。',
      emptyHint: '可在上方新建，或让助手帮你记录。',
      loading: '加载中…',
      unreadable: '有 {count} 个文件夹无法读取，已隐藏。',
      noSelection: '请选择一个文件查看或编辑。',
      noSelectionHint: '建议一个主题对应一个文件，文件名尽量使用便于搜索的关键词。',
      placeholder: '在此输入 Markdown 内容…',
      previewEmpty: '暂无可预览内容。',
      modeEdit: '编辑',
      modePreview: '预览',
      modified: '未保存',
      saved: '已保存',
      save: '保存',
      saving: '保存中…',
      revert: '还原',
      delete: '删除',
      deleteFolder: '删除文件夹',
      deleteFolderNamed: '删除文件夹 {path}',
      newFile: '新建文件',
      newFileInFolder: '在 {path} 中新建文件',
      newFolder: '新建文件夹',
      refresh: '刷新',
      cancel: '取消',
      create: '创建',
      discard: '放弃更改',
      saveAndSwitch: '保存并切换',
      confirmDelete: '确定删除 {path} 吗？此操作无法撤销。',
      confirmDeleteFolder: '确定删除文件夹 {path} 及其中的所有笔记吗？此操作无法撤销。',
      confirmDiscard: '{path} 有未保存的更改。',
      promptFile: '文件名（以 .md 结尾）',
      promptFolder: '文件夹名',
      createTargetRoot: '根目录',
      statsSummary: '{lines} 行 · {chars} 字符',
      shortcutHint: '⌘S / Ctrl+S 保存',
      loadFailed: '加载失败：{code}',
    }

    /** Failure codes the Host can return, mapped to readable text. */
    const ERROR_TEXT = {
      unknown_root: 'Memory directory is not configured.',
      unknown_op: 'Unsupported operation.',
      outside_root: 'Path is outside the memory directory.',
      wrong_extension: 'Only .md files are supported.',
      wrong_kind: 'Operation does not apply to this item.',
      unlisted_content: 'Folder contains hidden or non-Markdown items. Remove them manually first.',
      too_large: 'File exceeds the maximum allowed size.',
      not_found: 'File no longer exists.',
      denied: 'Permission denied by the filesystem.',
      invalid_body: 'Invalid request format.',
      invalid_encoding: 'File is not valid UTF-8 text.',
      internal: 'Internal error. Check the Harness log for details.',
    }

    /** Failure codes the Host can return, in the panel's second language. */
    const ERROR_TEXT_ZH = {
      unknown_root: '未配置记忆目录。',
      unknown_op: '不支持的操作。',
      outside_root: '目标路径超出记忆目录范围。',
      wrong_extension: '仅支持 .md 文件。',
      wrong_kind: '该操作不适用于当前条目。',
      unlisted_content: '文件夹内包含隐藏文件或非 Markdown 文件，请先在面板外手动清理。',
      too_large: '文件大小超出上限。',
      not_found: '文件已不存在。',
      denied: '文件系统拒绝访问。',
      invalid_body: '请求格式无效。',
      invalid_encoding: '文件不是有效的 UTF-8 文本。',
      internal: '内部错误，详情见 Harness 日志。',
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
     * Below this panel width the two-pane layout (a fixed 276px file tree beside
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

    /** Crisp 16px glyphs matching the shell stroke style. */
    function Glyph(props) {
      const size = props.size ?? 14
      const common = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false, style: { flexShrink: 0 },
      }
      switch (props.name) {
        case 'file':
          return h('svg', common,
            h('path', { d: 'M7 3h6.5L18 7.5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }),
            h('path', { d: 'M13.5 3v5H18' }))
        case 'folder':
          return h('svg', common,
            h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' }))
        case 'folderOpen':
          return h('svg', common,
            h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2H7.5L5 19H5a2 2 0 0 1-2-2V7z' }),
            h('path', { d: 'M5 19l2.5-8h13l-2 8H5z' }))
        case 'chevronRight':
          return h('svg', common, h('path', { d: 'M9.5 6.5L15 12l-5.5 5.5' }))
        case 'chevronDown':
          return h('svg', common, h('path', { d: 'M6.5 9.5L12 15l5.5-5.5' }))
        case 'plus':
          return h('svg', common, h('path', { d: 'M12 5v14M5 12h14' }))
        case 'folderPlus':
          return h('svg', common,
            h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' }),
            h('path', { d: 'M12 10.5v5M9.5 13h5' }))
        case 'refresh':
          return h('svg', common,
            h('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
            h('path', { d: 'M20 4v5h-5' }))
        case 'search':
          return h('svg', common,
            h('circle', { cx: 11, cy: 11, r: 6.5 }),
            h('path', { d: 'M16 16l4.5 4.5' }))
        case 'close':
          return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
        case 'trash':
          return h('svg', common,
            h('path', { d: 'M4 7h16M10 4h4M6.5 7l.9 13h9.2l.9-13M10 11v6M14 11v6' }))
        case 'eye':
          return h('svg', common,
            h('path', { d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z' }),
            h('circle', { cx: 12, cy: 12, r: 2.5 }))
        case 'edit':
          return h('svg', common,
            h('path', { d: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z' }),
            h('path', { d: 'M13.5 6.5l3 3' }))
        case 'check':
          return h('svg', common, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }))
        default:
          return null
      }
    }

    const CSS = `
.dsh-fm-page {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-fm-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2));
}
.dsh-fm-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-fm-title { font-size: 15px; line-height: 22px; font-weight: 600; margin: 0; }
.dsh-fm-subtitle { font-size: 12px; line-height: 18px; margin: 0; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #6b6b6b)); }
.dsh-fm-body { display: flex; flex: 1; min-height: 0; }
.dsh-fm-sidebar {
  width: 276px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0;
  background: var(--dsw-alias-bg-layer-1, transparent);
  border-right: 1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2));
}
.dsh-fm-sidebar-top {
  display: flex; flex-direction: column; gap: 8px; padding: 10px 10px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12));
}
.dsh-fm-dir-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-fm-search-wrap {
  position: relative; display: flex; align-items: center; gap: 6px;
  padding: 0 8px; height: 30px; border-radius: 7px;
  background: var(--dsw-alias-bg-base, transparent);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  color: var(--dsw-alias-label-tertiary, inherit);
  transition: border-color 120ms ease;
}
.dsh-fm-search-wrap:focus-within { border-color: var(--dsw-alias-brand-primary, #2f6feb); }
.dsh-fm-search {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 12.5px;
}
.dsh-fm-search::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, #888)); }
.dsh-fm-tree-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 6px 12px; scrollbar-width: thin; }
.dsh-fm-create-box {
  margin: 8px 10px 2px; padding: 8px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08));
  border: 1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2));
  display: flex; flex-direction: column; gap: 6px;
}
.dsh-fm-create-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); }
.dsh-fm-create-input {
  width: 100%; box-sizing: border-box; height: 28px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 12.5px;
}
.dsh-fm-create-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #2f6feb); }
.dsh-fm-create-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.dsh-fm-tree-row {
  display: flex; align-items: center; gap: 2px; border-radius: 6px; padding-right: 4px;
  transition: background 120ms ease;
}
.dsh-fm-tree-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-fm-tree-row[data-active="true"] { background: var(--dsw-alias-button-ghost-active-fill, rgba(128,128,128,.16)); }
.dsh-fm-node-btn {
  display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; text-align: left;
  appearance: none; border: none; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 12.5px; line-height: 20px;
  padding: 4px 6px; border-radius: 6px;
}
.dsh-fm-node-btn[data-dir="true"] { font-weight: 500; }
.dsh-fm-node-btn:focus-visible, .dsh-fm-icon-btn:focus-visible, .dsh-fm-btn:focus-visible, .dsh-fm-seg-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #2f6feb); outline-offset: 1px;
}
.dsh-fm-node-icon { color: var(--dsw-alias-label-tertiary, inherit); display: inline-flex; align-items: center; }
.dsh-fm-tree-row[data-active="true"] .dsh-fm-node-icon { color: var(--dsw-alias-label-primary, inherit); }
.dsh-fm-node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-fm-row-actions { display: inline-flex; align-items: center; gap: 2px; opacity: 0; transition: opacity 120ms ease; }
.dsh-fm-tree-row:hover .dsh-fm-row-actions, .dsh-fm-tree-row:focus-within .dsh-fm-row-actions { opacity: 1; }
@media (hover: none) { .dsh-fm-row-actions { opacity: 1; } }
.dsh-fm-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: none; border-radius: 5px;
  background: transparent; color: var(--dsw-alias-label-tertiary, inherit); cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dsh-fm-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); color: var(--dsw-alias-label-primary, inherit); }
.dsh-fm-icon-btn[data-danger="true"]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(200,60,60,.14));
  color: var(--dsw-alias-state-error-primary, #c0392b);
}
.dsh-fm-icon-btn:disabled { cursor: default; opacity: 0.35; }
.dsh-fm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.dsh-fm-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2));
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dsh-fm-path {
  flex: 1; min-width: 0; font-size: 12.5px; font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-secondary, inherit);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-fm-badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; line-height: 16px; font-weight: 500; white-space: nowrap;
}
.dsh-fm-badge[data-tone="warn"] {
  background: var(--dsw-alias-state-warn-tertiary, rgba(184,121,26,.14));
  color: var(--dsw-alias-state-warn-label, #b8791a);
}
.dsh-fm-badge[data-tone="ok"] {
  background: var(--dsw-alias-bg-layer-2, rgba(31,143,95,.12));
  color: var(--dsw-alias-state-success-primary, #1f8f5f);
}
.dsh-fm-segment {
  display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
}
.dsh-fm-seg-btn {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px;
  border: none; border-radius: 5px; background: transparent; cursor: pointer;
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit);
  transition: background 120ms ease, color 120ms ease;
}
.dsh-fm-seg-btn[aria-pressed="true"] {
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, inherit);
  box-shadow: var(--dsw-alias-shadow-s, 0 1px 2px rgba(0,0,0,.08));
}
.dsh-fm-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  appearance: none; font: inherit; font-size: 12px; font-weight: 500;
  height: 28px; padding: 0 11px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  background: var(--dsw-alias-button-elevated-fill, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.dsh-fm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-fm-btn[data-variant="primary"] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #2f6feb);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dsh-fm-btn[data-variant="primary"]:hover:not(:disabled) { opacity: 0.9; }
.dsh-fm-btn[data-variant="danger"] {
  border-color: var(--dsw-alias-state-error-primary, #c0392b);
  background: transparent;
  color: var(--dsw-alias-state-error-primary, #c0392b);
}
.dsh-fm-btn[data-variant="danger"]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(192,57,43,.12));
}
.dsh-fm-btn[data-size="sm"] { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 6px; }
.dsh-fm-btn:disabled { cursor: default; opacity: 0.45; }
.dsh-fm-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  margin: 10px 16px 0; padding: 9px 12px; border-radius: 8px; font-size: 12.5px; line-height: 1.5;
  border: 1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.25));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08));
}
.dsh-fm-banner[data-tone="error"] {
  border-color: var(--dsw-alias-state-error-primary, rgba(200,80,80,.45));
  color: var(--dsw-alias-state-error-primary, #c0392b);
}
.dsh-fm-banner[data-tone="warn"] {
  border-color: var(--dsw-alias-state-warn-label, rgba(184,121,26,.45));
  background: var(--dsw-alias-state-warn-tertiary, rgba(184,121,26,.1));
}
.dsh-fm-banner-actions { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.dsh-fm-editor {
  flex: 1; min-height: 0; width: 100%; resize: none; border: none; outline: none;
  padding: 16px 20px; font-size: 13.5px; line-height: 1.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: transparent; color: var(--dsw-alias-label-primary, inherit); box-sizing: border-box;
  scrollbar-width: thin;
}
.dsh-fm-preview {
  flex: 1; min-height: 0; overflow-y: auto; padding: 16px 22px 28px;
  font-size: 14px; line-height: 1.7; color: var(--dsw-alias-label-primary, inherit);
  scrollbar-width: thin;
}
.dsh-fm-preview h1, .dsh-fm-preview h2, .dsh-fm-preview h3, .dsh-fm-preview h4 {
  margin: 1.1em 0 0.45em; font-weight: 600; line-height: 1.35;
}
.dsh-fm-preview h1 { font-size: 1.4em; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16)); padding-bottom: 6px; }
.dsh-fm-preview h2 { font-size: 1.2em; }
.dsh-fm-preview h3 { font-size: 1.06em; }
.dsh-fm-preview > :first-child { margin-top: 0; }
.dsh-fm-preview p { margin: 0.6em 0; }
.dsh-fm-preview ul, .dsh-fm-preview ol { margin: 0.5em 0; padding-left: 1.5em; }
.dsh-fm-preview li { margin: 0.22em 0; }
.dsh-fm-preview blockquote {
  margin: 0.7em 0; padding: 4px 12px;
  border-left: 3px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-fm-preview code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em;
  padding: 1px 5px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
}
.dsh-fm-preview pre {
  margin: 0.7em 0; padding: 10px 12px; border-radius: 8px; overflow-x: auto;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18));
}
.dsh-fm-preview pre code { padding: 0; background: none; font-size: 12.5px; line-height: 1.55; }
.dsh-fm-preview hr { border: none; border-top: 1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2)); margin: 1.2em 0; }
.dsh-fm-preview a { color: var(--dsw-alias-link, var(--dsw-alias-brand-primary, #2f6feb)); text-decoration: underline; }
.dsh-fm-statusbar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 6px 16px; font-size: 11.5px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, inherit);
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  background: var(--dsw-alias-bg-layer-1, transparent);
  font-variant-numeric: tabular-nums;
}
.dsh-fm-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; gap: 8px; padding: 48px 20px; flex: 1;
  color: var(--dsw-alias-label-tertiary, inherit); font-size: 13px;
}
.dsh-fm-empty-title { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-secondary, inherit); }
.dsh-fm-empty-hint { font-size: 12px; max-width: 340px; line-height: 1.55; }
.dsh-fm-notice { padding: 16px 12px; font-size: 12.5px; color: var(--dsw-alias-label-tertiary, inherit); }
.dsh-fm-notice-hint { font-size: 11.5px; margin-top: 4px; opacity: 0.85; line-height: 1.5; }
`

    /** Filter a recursive tree by a case-insensitive substring query. */
    function filterTree(nodes, query) {
      if (query === '') return nodes
      const needle = query.toLowerCase()
      const next = []
      for (const node of nodes) {
        if (node.type === 'file') {
          if (node.name.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle)) {
            next.push(node)
          }
        } else {
          const children = filterTree(node.children, query)
          if (children.length > 0 || node.name.toLowerCase().includes(needle)) {
            next.push({ ...node, children })
          }
        }
      }
      return next
    }

    /** Render inline Markdown spans (code, bold, italic, safe links) as React nodes. */
    function renderInline(text) {
      const tokens = []
      const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[([^\]\n]+)\]\(([^)\s]+)\))/g
      let last = 0
      let index = 0
      for (const match of text.matchAll(pattern)) {
        if (match.index > last) tokens.push(text.slice(last, match.index))
        const raw = match[0]
        if (raw.startsWith('`')) {
          tokens.push(h('code', { key: `c${index++}` }, raw.slice(1, -1)))
        } else if (raw.startsWith('**')) {
          tokens.push(h('strong', { key: `b${index++}` }, raw.slice(2, -2)))
        } else if (raw.startsWith('*')) {
          tokens.push(h('em', { key: `i${index++}` }, raw.slice(1, -1)))
        } else {
          const label = match[2]
          const href = match[3]
          if (/^https?:\/\/|^mailto:/i.test(href)) {
            tokens.push(h('a', { key: `a${index++}`, href, target: '_blank', rel: 'noreferrer noopener' }, label))
          } else {
            tokens.push(raw)
          }
        }
        last = match.index + raw.length
      }
      if (last < text.length) tokens.push(text.slice(last))
      return tokens
    }

    /** Render Markdown text as safe React elements without HTML injection. */
    function MarkdownPreview(props) {
      const { text, emptyText } = props
      if (text.trim() === '') {
        return h('div', { className: 'dsh-fm-empty' }, h('div', { className: 'dsh-fm-empty-hint' }, emptyText))
      }
      const lines = text.replace(/\r\n/g, '\n').split('\n')
      const blocks = []
      let idx = 0
      let key = 0
      while (idx < lines.length) {
        const line = lines[idx]
        if (line.trim() === '') { idx += 1; continue }
        if (line.startsWith('```')) {
          const code = []
          idx += 1
          while (idx < lines.length && !lines[idx].startsWith('```')) {
            code.push(lines[idx])
            idx += 1
          }
          if (idx < lines.length) idx += 1
          blocks.push(h('pre', { key: `pre${key++}` }, h('code', null, code.join('\n'))))
          continue
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        if (heading) {
          blocks.push(h(`h${heading[1].length}`, { key: `h${key++}` }, renderInline(heading[2])))
          idx += 1
          continue
        }
        if (/^---+$|^\*\*\*+$/.test(line.trim())) {
          blocks.push(h('hr', { key: `hr${key++}` }))
          idx += 1
          continue
        }
        if (line.startsWith('>')) {
          const quote = []
          while (idx < lines.length && lines[idx].startsWith('>')) {
            quote.push(lines[idx].replace(/^>\s?/, ''))
            idx += 1
          }
          blocks.push(h('blockquote', { key: `bq${key++}` }, renderInline(quote.join(' '))))
          continue
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (idx < lines.length && /^\s*[-*+]\s+/.test(lines[idx])) {
            items.push(h('li', { key: `li${idx}` }, renderInline(lines[idx].replace(/^\s*[-*+]\s+/, ''))))
            idx += 1
          }
          blocks.push(h('ul', { key: `ul${key++}` }, items))
          continue
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = []
          while (idx < lines.length && /^\s*\d+\.\s+/.test(lines[idx])) {
            items.push(h('li', { key: `oli${idx}` }, renderInline(lines[idx].replace(/^\s*\d+\.\s+/, ''))))
            idx += 1
          }
          blocks.push(h('ol', { key: `ol${key++}` }, items))
          continue
        }
        const para = []
        while (
          idx < lines.length &&
          lines[idx].trim() !== '' &&
          !lines[idx].startsWith('```') &&
          !/^(#{1,4})\s+/.test(lines[idx]) &&
          !lines[idx].startsWith('>') &&
          !/^\s*[-*+]\s+/.test(lines[idx]) &&
          !/^\s*\d+\.\s+/.test(lines[idx]) &&
          !/^---+$|^\*\*\*+$/.test(lines[idx].trim())
        ) {
          para.push(lines[idx])
          idx += 1
        }
        blocks.push(h('p', { key: `p${key++}` }, renderInline(para.join(' '))))
      }
      return h('div', { className: 'dsh-fm-preview' }, blocks)
    }

    /** One directory row, recursively rendering its children while expanded. */
    function TreeNode(props) {
      const {
        node, depth, selected, onSelect, expanded, onToggle,
        onNewFileIn, onDeleteFolder, busy, t, touch, forceExpand,
      } = props
      const pad = { paddingLeft: 8 + depth * (touch ? 14 : 12) }
      if (node.type === 'file') {
        const active = selected === node.path
        return h('div', { className: 'dsh-fm-tree-row', 'data-active': String(active) },
          h('button', {
            type: 'button',
            className: 'dsh-fm-node-btn',
            style: { ...pad, ...(touch ? { fontSize: 13.5, padding: '7px 8px' } : null) },
            onClick: () => onSelect(node.path),
            title: node.path,
          },
          h('span', { className: 'dsh-fm-node-icon', style: { marginLeft: 14 } }, h(Glyph, { name: 'file', size: touch ? 15 : 13 })),
          h('span', { className: 'dsh-fm-node-name' }, node.name)))
      }
      const open = forceExpand || expanded.has(node.path)
      const children = node.children
      return h('div', null,
        h('div', { className: 'dsh-fm-tree-row' },
          h('button', {
            type: 'button',
            className: 'dsh-fm-node-btn',
            'data-dir': 'true',
            style: { ...pad, ...(touch ? { fontSize: 13.5, padding: '7px 8px' } : null) },
            onClick: () => onToggle(node.path),
            title: node.path,
            'aria-expanded': open,
          },
          h('span', { className: 'dsh-fm-node-icon' },
            h(Glyph, { name: open ? 'chevronDown' : 'chevronRight', size: 12 })),
          h('span', { className: 'dsh-fm-node-icon' },
            h(Glyph, { name: open ? 'folderOpen' : 'folder', size: touch ? 15 : 14 })),
          h('span', { className: 'dsh-fm-node-name' }, node.name)),
          h('div', { className: 'dsh-fm-row-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-fm-icon-btn',
              disabled: busy,
              title: fill(t('newFileInFolder'), { path: node.name }),
              'aria-label': fill(t('newFileInFolder'), { path: node.path }),
              onClick: () => onNewFileIn(node.path),
            }, h(Glyph, { name: 'plus', size: touch ? 15 : 13 })),
            h('button', {
              type: 'button',
              className: 'dsh-fm-icon-btn',
              'data-danger': 'true',
              disabled: busy,
              title: t('deleteFolder'),
              'aria-label': fill(t('deleteFolderNamed'), { path: node.path }),
              onClick: () => onDeleteFolder(node.path),
            }, h(Glyph, { name: 'trash', size: touch ? 15 : 13 })))),
        open
          ? children.map(child => h(TreeNode, {
            key: child.path, node: child, depth: depth + 1, selected, onSelect, expanded, onToggle,
            onNewFileIn, onDeleteFolder, busy, t, touch, forceExpand,
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
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [showTree, setShowTree] = useState(true)
      const [searchQuery, setSearchQuery] = useState('')
      const [mode, setMode] = useState('edit')
      const [savedBanner, setSavedBanner] = useState(false)
      const [creating, setCreating] = useState(null)
      const [createName, setCreateName] = useState('')
      const [confirmAction, setConfirmAction] = useState(null)
      const pageRef = useRef(null)
      const createInputRef = useRef(null)
      const savedTimerRef = useRef(null)
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

      useEffect(() => () => {
        if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current)
      }, [])

      useEffect(() => {
        if (creating !== null) createInputRef.current?.focus()
      }, [creating])

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

      const loadFile = useCallback(async (path) => {
        setBusy(true)
        setError(null)
        setConfirmAction(null)
        try {
          const payload = await call(READ_PATH, { op: 'file', path })
          setSelected(payload.path)
          setText(payload.text)
          setSavedText(payload.text)
          setSavedBanner(false)
          if (narrowRef.current) setShowTree(false)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [])

      const openFile = useCallback((path) => {
        if (path === selected) {
          if (narrowRef.current) setShowTree(false)
          return
        }
        if (dirtyRef.current) {
          setConfirmAction({ type: 'discard-open', targetPath: path })
          return
        }
        void loadFile(path)
      }, [selected, loadFile])

      const save = useCallback(async () => {
        if (selected === null) return false
        setBusy(true)
        setError(null)
        try {
          await call(MUTATE_PATH, { op: 'write', path: selected },
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
          setSavedText(text)
          setSavedBanner(true)
          if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current)
          savedTimerRef.current = setTimeout(() => setSavedBanner(false), 2400)
          await refresh()
          return true
        } catch (cause) {
          setError(cause.message)
          return false
        } finally {
          setBusy(false)
        }
      }, [selected, text, refresh])

      const performDeleteFile = useCallback(async (path) => {
        setBusy(true)
        setError(null)
        setConfirmAction(null)
        try {
          await call(MUTATE_PATH, { op: 'delete', path },
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (selected === path) {
            setSelected(null)
            setText('')
            setSavedText('')
          }
          await refresh()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [selected, refresh])

      const performDeleteFolder = useCallback(async (path) => {
        setBusy(true)
        setError(null)
        setConfirmAction(null)
        try {
          await call(MUTATE_PATH, { op: 'delete', path },
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (selected !== null && (selected === path || selected.startsWith(`${path}/`))) {
            setSelected(null)
            setText('')
            setSavedText('')
          }
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
      }, [selected, refresh])

      const beginCreate = useCallback((kind, parentPath = '') => {
        setError(null)
        setCreating({ kind, parentPath })
        setCreateName('')
        if (parentPath !== '') {
          setExpanded(previous => new Set(previous).add(parentPath))
        }
      }, [])

      const submitCreate = useCallback(async () => {
        if (creating === null) return
        const raw = createName.trim().replace(/^\/+|\/+$/g, '')
        if (raw === '') return
        const { kind, parentPath } = creating
        const finalName = kind === 'file' && !raw.includes('.') ? `${raw}.md` : raw
        const path = parentPath === '' ? finalName : `${parentPath}/${finalName}`
        setBusy(true)
        setError(null)
        try {
          if (kind === 'file') {
            if (!finalName.toLowerCase().endsWith('.md')) throw new Error('wrong_extension')
            await call(MUTATE_PATH, { op: 'write', path },
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) })
          } else {
            await call(MUTATE_PATH, { op: 'mkdir', path },
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            setExpanded(previous => new Set(previous).add(path))
          }
          setCreating(null)
          setCreateName('')
          await refresh()
          if (kind === 'file') await loadFile(path)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [creating, createName, refresh, loadFile])

      const toggle = useCallback((path) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
      }, [])

      useEffect(() => {
        const service = ctxRef.current?.locale
        if (service === undefined) return undefined
        const read = () => setLocale(activeLocale(service))
        read()
        return service.subscribe(read)
      }, [])

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

      const trimmedQuery = searchQuery.trim()
      const filteredTree = useMemo(
        () => (tree === null ? null : filterTree(tree, trimmedQuery)),
        [tree, trimmedQuery],
      )

      const lineCount = text === '' ? 0 : text.split('\n').length
      const charCount = text.length
      const treeVisible = !narrow || selected === null || showTree

      const confirmBanner = (() => {
        if (confirmAction === null) return null
        if (confirmAction.type === 'delete-file') {
          return h('div', { className: 'dsh-fm-banner', 'data-tone': 'warn', role: 'alert' },
            h('span', null, t('confirmDelete', { path: confirmAction.path })),
            h('div', { className: 'dsh-fm-banner-actions' },
              h('button', {
                type: 'button', className: 'dsh-fm-btn', 'data-variant': 'danger', 'data-size': 'sm',
                disabled: busy, onClick: () => void performDeleteFile(confirmAction.path),
              }, t('delete')),
              h('button', {
                type: 'button', className: 'dsh-fm-btn', 'data-size': 'sm',
                disabled: busy, onClick: () => setConfirmAction(null),
              }, t('cancel'))))
        }
        if (confirmAction.type === 'delete-folder') {
          return h('div', { className: 'dsh-fm-banner', 'data-tone': 'warn', role: 'alert' },
            h('span', null, t('confirmDeleteFolder', { path: confirmAction.path })),
            h('div', { className: 'dsh-fm-banner-actions' },
              h('button', {
                type: 'button', className: 'dsh-fm-btn', 'data-variant': 'danger', 'data-size': 'sm',
                disabled: busy, onClick: () => void performDeleteFolder(confirmAction.path),
              }, t('delete')),
              h('button', {
                type: 'button', className: 'dsh-fm-btn', 'data-size': 'sm',
                disabled: busy, onClick: () => setConfirmAction(null),
              }, t('cancel'))))
        }
        return h('div', { className: 'dsh-fm-banner', 'data-tone': 'warn', role: 'alert' },
          h('span', null, t('confirmDiscard', { path: selected ?? '' })),
          h('div', { className: 'dsh-fm-banner-actions' },
            h('button', {
              type: 'button', className: 'dsh-fm-btn', 'data-variant': 'primary', 'data-size': 'sm',
              disabled: busy,
              onClick: async () => {
                const ok = await save()
                if (ok) await loadFile(confirmAction.targetPath)
              },
            }, t('saveAndSwitch')),
            h('button', {
              type: 'button', className: 'dsh-fm-btn', 'data-size': 'sm',
              disabled: busy,
              onClick: () => void loadFile(confirmAction.targetPath),
            }, t('discard')),
            h('button', {
              type: 'button', className: 'dsh-fm-btn', 'data-size': 'sm',
              disabled: busy, onClick: () => setConfirmAction(null),
            }, t('cancel'))))
      })()

      return h('div', {
        ref: pageRef,
        className: 'dsh-fm-page',
        style: narrow ? { boxSizing: 'border-box', paddingBottom: 'env(safe-area-inset-bottom, 0px)' } : undefined,
      },
      h('style', { 'data-plugin-css': 'dsh-file-memory' }, CSS),
      h('div', {
        className: 'dsh-fm-header',
        style: narrow ? { padding: '10px 14px' } : undefined,
      },
      h('div', { className: 'dsh-fm-heading' },
        h('h2', { className: 'dsh-fm-title' }, t('panelTitle')),
        narrow ? null : h('p', { className: 'dsh-fm-subtitle' }, t('panelSubtitle'))),
      narrow && selected !== null
        ? h('button', {
          type: 'button', className: 'dsh-fm-btn', 'data-size': 'sm', disabled: busy,
          'aria-expanded': treeVisible,
          onClick: () => setShowTree(shown => !shown),
        }, treeVisible ? t('hideFiles') : t('files'))
        : null),
      error !== null
        ? h('div', { className: 'dsh-fm-banner', 'data-tone': 'error', role: 'alert' },
          h('span', null, locale === 'zh'
            ? (ERROR_TEXT_ZH[error] ?? t('loadFailed', { code: error }))
            : (ERROR_TEXT[error] ?? t('loadFailed', { code: error }))),
          h('button', {
            type: 'button', className: 'dsh-fm-icon-btn', 'aria-label': t('cancel'),
            onClick: () => setError(null),
          }, h(Glyph, { name: 'close', size: 13 })))
        : null,
      confirmBanner,
      h('div', {
        className: 'dsh-fm-body',
        style: narrow ? { flexDirection: 'column' } : undefined,
      },
      treeVisible
        ? h('div', {
          className: 'dsh-fm-sidebar',
          style: narrow
            ? { width: '100%', maxHeight: '42vh', borderRight: 'none', borderBottom: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.2))' }
            : undefined,
        },
        h('div', { className: 'dsh-fm-sidebar-top' },
          h('div', { className: 'dsh-fm-dir-toolbar' },
            h('button', {
              type: 'button', className: 'dsh-fm-btn', 'data-size': 'sm', disabled: busy,
              onClick: () => beginCreate('file', ''),
            }, h(Glyph, { name: 'plus', size: 12 }), t('newFile')),
            h('button', {
              type: 'button', className: 'dsh-fm-btn', 'data-size': 'sm', disabled: busy,
              onClick: () => beginCreate('folder', ''),
            }, h(Glyph, { name: 'folderPlus', size: 12 }), t('newFolder')),
            h('button', {
              type: 'button', className: 'dsh-fm-icon-btn', disabled: busy,
              style: { marginLeft: 'auto' },
              title: t('refresh'), 'aria-label': t('refresh'),
              onClick: () => void refresh(),
            }, h(Glyph, { name: 'refresh', size: 14 }))),
          h('div', { className: 'dsh-fm-search-wrap' },
            h(Glyph, { name: 'search', size: 13 }),
            h('input', {
              className: 'dsh-fm-search',
              type: 'text',
              value: searchQuery,
              placeholder: t('searchPlaceholder'),
              'aria-label': t('searchPlaceholder'),
              onChange: event => setSearchQuery(event.target.value),
            }),
            searchQuery === ''
              ? null
              : h('button', {
                type: 'button', className: 'dsh-fm-icon-btn',
                style: { width: 20, height: 20 },
                title: t('clearSearch'), 'aria-label': t('clearSearch'),
                onClick: () => setSearchQuery(''),
              }, h(Glyph, { name: 'close', size: 11 })))),
        creating === null
          ? null
          : h('div', { className: 'dsh-fm-create-box' },
            h('div', { className: 'dsh-fm-create-meta' },
              `${creating.kind === 'file' ? t('newFile') : t('newFolder')} · ${creating.parentPath === '' ? t('createTargetRoot') : creating.parentPath}`),
            h('input', {
              ref: createInputRef,
              className: 'dsh-fm-create-input',
              type: 'text',
              value: createName,
              placeholder: creating.kind === 'file' ? t('promptFile') : t('promptFolder'),
              onChange: event => setCreateName(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  void submitCreate()
                }
                if (event.key === 'Escape') {
                  setCreating(null)
                  setCreateName('')
                }
              },
            }),
            h('div', { className: 'dsh-fm-create-actions' },
              h('button', {
                type: 'button', className: 'dsh-fm-btn', 'data-size': 'sm',
                disabled: busy,
                onClick: () => { setCreating(null); setCreateName('') },
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'dsh-fm-btn', 'data-variant': 'primary', 'data-size': 'sm',
                disabled: busy || createName.trim() === '',
                onClick: () => void submitCreate(),
              }, t('create')))),
        h('div', { className: 'dsh-fm-tree-scroll' },
          filteredTree === null
            ? h('div', { className: 'dsh-fm-notice' }, t('loading'))
            : tree.length === 0
              ? h('div', { className: 'dsh-fm-notice' }, t('empty'), h('div', { className: 'dsh-fm-notice-hint' }, t('emptyHint')))
              : filteredTree.length === 0
                ? h('div', { className: 'dsh-fm-notice' }, t('noMatches', { query: trimmedQuery }))
                : filteredTree.map(node => h(TreeNode, {
                  key: node.path, node, depth: 0, selected, onSelect: openFile,
                  expanded, onToggle: toggle,
                  onNewFileIn: path => beginCreate('file', path),
                  onDeleteFolder: path => setConfirmAction({ type: 'delete-folder', path }),
                  busy, t, touch: narrow, forceExpand: trimmedQuery !== '',
                })),
          unreadable > 0
            ? h('div', { className: 'dsh-fm-notice-hint', style: { padding: '8px 8px 0' } }, t('unreadable', { count: unreadable }))
            : null))
        : null,
      h('div', { className: 'dsh-fm-main' },
        selected === null
          ? h('div', { className: 'dsh-fm-empty' },
            h(Glyph, { name: 'file', size: 28 }),
            h('div', { className: 'dsh-fm-empty-title' }, t('noSelection')),
            h('div', { className: 'dsh-fm-empty-hint' }, t('noSelectionHint')))
          : h(React.Fragment, null,
            h('div', {
              className: 'dsh-fm-toolbar',
              style: narrow ? { flexWrap: 'wrap', padding: '8px 12px', gap: 6 } : undefined,
            },
            h('span', {
              className: 'dsh-fm-path',
              style: narrow ? { flex: '1 1 100%' } : undefined,
              title: selected,
            }, selected),
            dirty
              ? h('span', { className: 'dsh-fm-badge', 'data-tone': 'warn' }, t('modified'))
              : savedBanner
                ? h('span', { className: 'dsh-fm-badge', 'data-tone': 'ok' }, h(Glyph, { name: 'check', size: 11 }), t('saved'))
                : null,
            h('div', { className: 'dsh-fm-segment', role: 'group' },
              h('button', {
                type: 'button', className: 'dsh-fm-seg-btn', 'aria-pressed': String(mode === 'edit'),
                onClick: () => setMode('edit'),
              }, h(Glyph, { name: 'edit', size: 12 }), t('modeEdit')),
              h('button', {
                type: 'button', className: 'dsh-fm-seg-btn', 'aria-pressed': String(mode === 'preview'),
                onClick: () => setMode('preview'),
              }, h(Glyph, { name: 'eye', size: 12 }), t('modePreview'))),
            h('button', {
              type: 'button', className: 'dsh-fm-btn', 'data-variant': 'primary',
              disabled: busy || !dirty,
              onClick: () => void save(),
            }, busy && dirty ? t('saving') : t('save')),
            h('button', {
              type: 'button', className: 'dsh-fm-btn',
              disabled: busy || !dirty,
              onClick: () => setText(savedText),
            }, t('revert')),
            h('button', {
              type: 'button', className: 'dsh-fm-btn', 'data-variant': 'danger',
              disabled: busy,
              onClick: () => setConfirmAction({ type: 'delete-file', path: selected }),
            }, t('delete'))),
            mode === 'preview'
              ? h(MarkdownPreview, { text, emptyText: t('previewEmpty') })
              : h('textarea', {
                className: 'dsh-fm-editor',
                style: narrow ? { padding: '12px', fontSize: '15px', lineHeight: 1.6 } : undefined,
                value: text, spellCheck: false, placeholder: t('placeholder'),
                onChange: (event) => {
                  setSavedBanner(false)
                  setText(event.target.value)
                },
              }),
            h('div', { className: 'dsh-fm-statusbar' },
              h('span', null, t('statsSummary', { lines: lineCount, chars: charCount })),
              narrow ? null : h('span', null, t('shortcutHint')))))))
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
