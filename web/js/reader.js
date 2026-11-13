import { call, getJSON, isNative, platform } from './bridge.js'
import { settings, updateSettings, onSettings, THEMES, FONTS, fontStack, themeColors } from './settings.js'
import { icons } from './icons.js'
import { $, $$, esc, h, debounce, clamp, percent, duration, toast, clothColor, cleanTitle, langMap, contributors } from './util.js'
import { startWindowDrag, showMenu } from './chrome.js'
import { readerCSS, tuneDocument, writingModeOf, HIGHLIGHTS } from './reader-style.js'

const FOLIATE = '../vendor/foliate-js/'
const encodePath = name => name.split('/').map(encodeURIComponent).join('/')

// An EPUB "loader" backed by the host: the host serves every entry of the book
// (whether it is a zip file or an unpacked folder) under /book/<id>/.
const openBook = async id => {
    const sizes = await getJSON(`/api/entries/${id}`)
    // File systems and manifests don't always agree on Unicode normalisation,
    // so entries are looked up by their NFC form.
    const names = new Map(Object.keys(sizes).map(name => [name.normalize('NFC'), name]))
    const real = name => names.get(name.normalize('NFC'))
    const url = name => `/book/${id}/${encodePath(real(name))}`
    const has = name => names.has(name.normalize('NFC'))
    const loader = {
        entries: Object.keys(sizes).map(filename => ({ filename })),
        loadText: async name => has(name) ? (await fetch(url(name))).text() : null,
        loadBlob: async (name, type) => {
            if (!has(name)) return null
            const blob = await (await fetch(url(name))).blob()
            return type && blob.type !== type ? new Blob([blob], { type }) : blob
        },
        getSize: name => sizes[real(name)] ?? 0,
    }
    const { EPUB } = await import(FOLIATE + 'epub.js')
    return new EPUB(loader).init()
}

const flattenTOC = (items, depth = 0, out = []) => {
    for (const item of items ?? []) {
        out.push({ label: (item.label ?? '').trim(), href: item.href, depth })
        flattenTOC(item.subitems, depth + 1, out)
    }
    return out
}

export const mountReader = (root, id, { onClose }) => {
    let alive = true
    let book, view, Overlayer, CFI
    let state = { annotations: [], bookmarks: [] }
    let location = null       // last `relocate` detail
    let vertical = false
    let fxl = false
    let toc = []
    let meta = { title: '', author: '' }
    const cleanups = []

    const el = h(`
    <div class="reader">
        <div class="rd-stage"></div>
        <div class="rd-run head"><span></span></div>
        <div class="rd-run foot"><span class="l"></span><span class="r"></span></div>
        <div class="rd-ribbon"></div>
        <div class="rd-loading"><div>正在翻开…</div></div>

        <header class="rd-bar" data-drag>
            <div class="side" data-drag>
                <button class="icon-btn" data-act="close" title="返回书库（Esc）">${icons.back}</button>
                <button class="icon-btn" data-act="toc" title="目录（T）">${icons.toc}</button>
            </div>
            <div class="rd-bar-title" data-drag><b data-drag></b><span data-drag></span></div>
            <div class="side r" data-drag>
                <button class="icon-btn" data-act="search" title="搜索（⌘F）">${icons.search}</button>
                <button class="icon-btn" data-act="notes" title="笔记与书签（N）">${icons.notes}</button>
                <button class="icon-btn" data-act="bookmark" title="添加书签（⌘D）">${icons.bookmark}</button>
                <button class="icon-btn" data-act="settings" title="显示设置">${icons.type}</button>
            </div>
        </header>

        <div class="rd-scrub">
            <input type="range" min="0" max="1" step="any" value="0" aria-label="阅读进度">
            <div class="info"><span class="l"></span><span class="r"></span></div>
        </div>
        <button class="rd-chip">${icons.undo}<span>回到刚才的位置</span></button>

        <div class="rd-scrim"></div>
        <aside class="rd-drawer">
            <div class="rd-drawer-head">
                <div class="seg">
                    <button data-tab="toc" class="on">目录</button>
                    <button data-tab="notes">笔记</button>
                    <button data-tab="search">搜索</button>
                </div>
            </div>
            <div class="rd-book"></div>
            <div class="rd-pane on" data-pane="toc"></div>
            <div class="rd-pane" data-pane="notes"></div>
            <div class="rd-pane" data-pane="search">
                <div class="search-box"><label class="lib-search">${icons.search}<input type="search" placeholder="在全书中搜索" spellcheck="false"></label></div>
                <div class="search-results"></div>
            </div>
        </aside>

        <div class="rd-pop rd-settings"></div>
        <div class="rd-pop rd-sel">
            ${Object.entries(HIGHLIGHTS).map(([k, c]) =>
                `<button class="dot" data-color="${k}" style="--c:${c}" title="高亮"><i></i></button>`).join('')}
            <button class="icon-btn" data-sel="underline" title="下划线">${icons.underline}</button>
            <span class="sep"></span>
            <button class="icon-btn" data-sel="note" title="写笔记">${icons.notes}</button>
            <button class="icon-btn" data-sel="copy" title="拷贝">${icons.copy}</button>
            <button class="icon-btn" data-sel="find" title="在全书中搜索">${icons.search}</button>
            ${platform !== 'web' ? `<button class="icon-btn" data-sel="lookup" title="查词典">${icons.dict}</button>` : ''}
            <button class="icon-btn" data-sel="delete" title="删除">${icons.trash}</button>
            <textarea placeholder="写点什么…  ⌘↩ 保存"></textarea>
        </div>
        <div class="rd-pop rd-note-card"></div>
        <div class="rd-image"><img alt=""></div>
    </div>`)
    root.replaceChildren(el)

    const stage = $('.rd-stage', el)
    const loading = $('.rd-loading', el)
    const scrub = $('.rd-scrub input', el)
    const chip = $('.rd-chip', el)
    const settingsPop = $('.rd-settings', el)
    const selPop = $('.rd-sel', el)
    const noteCard = $('.rd-note-card', el)
    const imageView = $('.rd-image', el)
    const searchInput = $('.rd-pane[data-pane="search"] input', el)
    const searchResults = $('.search-results', el)

    // ── persistence ───────────────────────────────────────────────
    const saveState = debounce(() => {
        if (book) call('saveState', { id, state }).catch(console.error)
    }, 500)

    // ── chrome visibility ─────────────────────────────────────────
    // The bars stay out of the way: they appear when the pointer nears the top
    // or bottom edge (or on a tap in the middle of the page) and slip away again.
    let uiPinned = false, hideTimer = null
    const overlayOpen = () => el.classList.contains('drawer') || settingsPop.classList.contains('show')
    const setUI = on => el.classList.toggle('ui', on || uiPinned || overlayOpen())
    const cancelHide = () => { clearTimeout(hideTimer); hideTimer = null }
    const scheduleHide = ms => {
        if (hideTimer) return
        hideTimer = setTimeout(() => { hideTimer = null; setUI(false) }, ms)
    }
    const showUI = (on, linger = 0) => {
        cancelHide()
        setUI(on)
        if (on && linger) scheduleHide(linger)
    }
    const toggleUI = () => {
        uiPinned = !el.classList.contains('ui')
        showUI(uiPinned)
    }
    const unpinUI = () => {
        uiPinned = false
        showUI(false)
    }
    const noHover = matchMedia('(hover: none)')
    const pointerAt = y => {
        if (noHover.matches) return
        if (y < 64 || y > innerHeight - 72) showUI(true)
        else if (el.classList.contains('ui') && !uiPinned) scheduleHide(900)
    }
    el.addEventListener('mousemove', e => {
        if (e.target.closest('.rd-bar, .rd-scrub')) showUI(true)
        else pointerAt(e.clientY)
    })
    document.documentElement.addEventListener('mouseleave', () => { if (!uiPinned) scheduleHide(400) }, { signal: abortSignal() })

    function abortSignal() {
        const c = new AbortController()
        cleanups.push(() => c.abort())
        return c.signal
    }
    const signal = abortSignal()

    // window furniture (the Mac's traffic lights) follows our own bars
    let chromeShown = null
    const syncChrome = () => {
        const on = el.classList.contains('ui')
        if (on === chromeShown) return
        chromeShown = on
        call('setChrome', { visible: on }).catch(() => {})
    }
    new MutationObserver(syncChrome).observe(el, { attributes: true, attributeFilter: ['class'] })
    syncChrome()
    cleanups.push(() => call('setChrome', { visible: true }).catch(() => {}))

    // ── layout & style ────────────────────────────────────────────
    const applyLayout = () => {
        const r = view?.renderer
        if (!r || fxl) return
        const w = stage.clientWidth
        const two = settings.columns === '2' || (settings.columns === 'auto' && w >= 1040)
        r.setAttribute('flow', settings.flow === 'scrolled' ? 'scrolled' : 'paginated')
        r.setAttribute('max-inline-size', settings.pageWidth + 'px')
        r.setAttribute('max-column-count', two && !vertical ? 2 : 1)
        r.setAttribute('gap', w < 640 ? '7%' : '6%')
        r.setAttribute('margin', '56px')
        r.toggleAttribute('animated', !!settings.animated)
        view.toggleAttribute('autohide-cursor', true)
    }
    const applyStyle = () => {
        if (!view?.renderer?.setStyles || fxl) return
        view.renderer.setStyles(readerCSS())
    }
    new ResizeObserver(() => applyLayout()).observe(stage)

    // ── navigation helpers ────────────────────────────────────────
    const next = () => view?.next()
    const prev = () => view?.prev()
    const left = () => (vertical || book?.dir === 'rtl') ? next() : prev()
    const right = () => (vertical || book?.dir === 'rtl') ? prev() : next()
    let chipTimer
    const jump = async target => {
        if (!view) return
        hideSel()
        await (typeof target === 'object' && 'fraction' in target
            ? view.goToFraction(target.fraction) : view.goTo(target))
        if (view.history.canGoBack) {
            chip.classList.add('show')
            clearTimeout(chipTimer)
            chipTimer = setTimeout(() => chip.classList.remove('show'), 9000)
        }
    }
    chip.addEventListener('click', () => {
        view?.history.back()
        chip.classList.remove('show')
    })

    // ── drawer ────────────────────────────────────────────────────
    const openDrawer = tab => {
        closeSettings()
        el.classList.add('drawer', 'ui')
        setTab(tab)
    }
    const closeDrawer = ({ keepSearch = false } = {}) => {
        el.classList.remove('drawer')
        scheduleHide(600)
        view?.renderer?.focusView?.()
        // search outlines are for finding your place, not for reading through
        if (keepSearch) searchLinger = 3
        else { searchLinger = 0; view?.clearSearch() }
    }
    const setTab = tab => {
        for (const b of $$('.rd-drawer [data-tab]', el)) b.classList.toggle('on', b.dataset.tab === tab)
        for (const p of $$('.rd-pane', el)) p.classList.toggle('on', p.dataset.pane === tab)
        if (tab === 'toc') renderTOC(true)
        if (tab === 'notes') renderNotes()
        if (tab === 'search') setTimeout(() => { searchInput.focus(); searchInput.select() }, 60)
    }
    $('.rd-scrim', el).addEventListener('click', () => closeDrawer())
    $('.rd-drawer-head', el).addEventListener('click', e => {
        const b = e.target.closest('[data-tab]')
        if (b) setTab(b.dataset.tab)
    })

    const tocPane = $('.rd-pane[data-pane="toc"]', el)
    const renderTOC = scroll => {
        const cur = location?.tocItem?.href
        if (!toc.length) {
            tocPane.innerHTML = `<div class="pane-empty">这本书没有目录</div>`
            return
        }
        tocPane.innerHTML = toc.map((t, i) => `
            <button class="toc-item d${Math.min(t.depth, 3)}${t.href === cur ? ' cur' : ''}" data-i="${i}"
                style="padding-left:${12 + t.depth * 16}px"><span class="lbl">${esc(t.label)}</span></button>`).join('')
        if (scroll) $('.cur', tocPane)?.scrollIntoView({ block: 'center' })
    }
    tocPane.addEventListener('click', e => {
        const b = e.target.closest('[data-i]')
        if (!b) return
        jump(toc[b.dataset.i].href)
        closeDrawer()
    })

    // ── annotations & bookmarks ───────────────────────────────────
    const notesPane = $('.rd-pane[data-pane="notes"]', el)
    const dateFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
    const renderNotes = () => {
        const marks = state.bookmarks.map(b => ({ ...b, kind: 'bm' }))
        const notes = state.annotations.map(a => ({ ...a, kind: 'an' }))
        const all = [...marks, ...notes].sort((a, b) =>
            (a.index - b.index) || CFI.compare(a.cfi ?? a.value, b.cfi ?? b.value))
        if (!all.length) {
            notesPane.innerHTML = `<div class="pane-empty">还没有笔记<br>选中一段文字即可高亮或批注，<br>按 ⌘D 可为当前页加书签。</div>`
            return
        }
        notesPane.innerHTML = `
            <div class="pane-head"><span>${state.annotations.length} 条笔记 · ${state.bookmarks.length} 个书签</span>
                <button data-act="export">${icons.exportIcon}导出</button></div>` +
            all.map(x => x.kind === 'bm' ? `
                <div class="note-item bm" role="button" tabindex="0" data-cfi="${esc(x.cfi)}">
                    <q>${esc(x.excerpt || x.label || '书签')}</q>
                    <small>书签 · ${esc(x.label || '')}${x.fraction != null ? ' · ' + percent(x.fraction) : ''}</small>
                    <button class="icon-btn del" data-del-bm="${esc(x.cfi)}" title="删除">${icons.trash}</button>
                </div>` : `
                <div class="note-item" role="button" tabindex="0" data-cfi="${esc(x.value)}" style="--c:${HIGHLIGHTS[x.color] ?? HIGHLIGHTS.yellow}">
                    <q>${esc(x.text)}</q>
                    ${x.note ? `<p>${esc(x.note)}</p>` : ''}
                    <small>${esc(x.chapter || '')}${x.created ? ' · ' + dateFmt.format(x.created) : ''}</small>
                    <button class="icon-btn del" data-del-an="${esc(x.value)}" title="删除">${icons.trash}</button>
                </div>`).join('')
    }
    notesPane.addEventListener('click', e => {
        const del = e.target.closest('[data-del-bm], [data-del-an]')
        if (del) {
            if (del.dataset.delBm) removeBookmark(del.dataset.delBm)
            else removeAnnotation(del.dataset.delAn)
            renderNotes()
            return
        }
        if (e.target.closest('[data-act="export"]')) return exportNotes()
        const item = e.target.closest('[data-cfi]')
        if (item) { jump(item.dataset.cfi); closeDrawer() }
    })

    const exportNotes = async () => {
        const lines = [`# ${meta.title}`, '']
        if (meta.author) lines.push(meta.author, '')
        let chapter = null
        const sorted = [...state.annotations].sort((a, b) => (a.index - b.index) || CFI.compare(a.value, b.value))
        for (const a of sorted) {
            if (a.chapter !== chapter) { chapter = a.chapter; lines.push(`## ${chapter || '未命名章节'}`, '') }
            lines.push(...a.text.trim().split(/\n+/).map(l => `> ${l}`), '')
            if (a.note) lines.push(a.note, '')
        }
        const ok = await call('exportText', { name: `${meta.title} - 笔记.md`, text: lines.join('\n') })
        if (ok) toast('笔记已导出')
    }

    const drawAnnotation = a => view.addAnnotation(a).catch(console.error)
    const removeAnnotation = value => {
        const i = state.annotations.findIndex(a => a.value === value)
        if (i < 0) return
        const [a] = state.annotations.splice(i, 1)
        view.deleteAnnotation(a).catch(console.error)
        saveState()
    }

    const visibleBookmarks = () => {
        const range = location?.range
        if (!range || !view) return []
        const doc = range.startContainer.ownerDocument
        const index = location.section?.current
        return state.bookmarks.filter(b => {
            if (b.index !== index) return false
            try {
                const r = view.resolveCFI(b.cfi).anchor(doc)
                const node = r.startContainer ?? r, offset = r.startOffset ?? 0
                return range.comparePoint(node, offset) === 0
            } catch {
                return false
            }
        })
    }
    const refreshBookmarkState = () => {
        const on = visibleBookmarks().length > 0
        $('.rd-ribbon', el).classList.toggle('show', on)
        const btn = $('[data-act="bookmark"]', el)
        btn.classList.toggle('on', on)
        btn.innerHTML = on ? icons.bookmarkFill : icons.bookmark
        btn.title = on ? '移除书签（⌘D）' : '添加书签（⌘D）'
    }
    const removeBookmark = cfi => {
        state.bookmarks = state.bookmarks.filter(b => b.cfi !== cfi)
        saveState()
        refreshBookmarkState()
    }
    const toggleBookmark = () => {
        if (!location?.cfi) return
        const here = visibleBookmarks()
        if (here.length) {
            for (const b of here) removeBookmark(b.cfi)
            toast('已移除书签')
        } else {
            state.bookmarks.push({
                cfi: location.cfi,
                index: location.section?.current ?? 0,
                label: location.tocItem?.label?.trim() ?? '',
                excerpt: (location.range?.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
                fraction: location.fraction,
                created: Date.now(),
            })
            saveState()
            refreshBookmarkState()
            toast('已添加书签')
        }
    }

    // ── selection toolbar ─────────────────────────────────────────
    // `sel` describes what the toolbar is acting on: a fresh text selection
    // ({ range, index, doc }) or an existing annotation ({ annotation, … }).
    let sel = null
    const noteArea = $('textarea', selPop)
    const hideSel = () => {
        if (sel?.annotation && selPop.classList.contains('noting')) commitNote()
        selPop.classList.remove('show', 'noting')
        sel = null
    }
    const placeSel = range => {
        const frame = range.startContainer.ownerDocument.defaultView.frameElement
        if (!frame) return
        const f = frame.getBoundingClientRect()
        const host = el.getBoundingClientRect()
        const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
            .map(r => ({ left: r.left + f.left, right: r.right + f.left, top: r.top + f.top, bottom: r.bottom + f.top }))
            .filter(r => r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom)
        if (!rects.length) return
        const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom))
        const firstLine = rects.filter(r => r.top < top + 4)
        const cx = (Math.min(...firstLine.map(r => r.left)) + Math.max(...firstLine.map(r => r.right))) / 2
        selPop.classList.add('show')
        const { width, height } = selPop.getBoundingClientRect()
        const x = clamp(cx - width / 2, 8, host.width - width - 8)
        let y = top - height - 10
        if (y < 8) y = Math.min(bottom + 10, host.height - height - 8)
        Object.assign(selPop.style, { left: x + 'px', top: y + 'px' })
    }
    const showSelFor = (range, index, annotation = null) => {
        sel = { range, index, annotation }
        selPop.classList.remove('noting')
        for (const d of $$('.dot', selPop))
            d.classList.toggle('on', !!annotation && annotation.style !== 'underline' && annotation.color === d.dataset.color)
        $('[data-sel="underline"]', selPop).classList.toggle('on', annotation?.style === 'underline')
        $('[data-sel="delete"]', selPop).style.display = annotation ? '' : 'none'
        $('[data-sel="find"]', selPop).style.display = annotation ? 'none' : ''
        placeSel(range)
        if (annotation?.note) openNote()
    }
    const ensureAnnotation = (patch = {}) => {
        if (!sel) return null
        if (sel.annotation) {
            Object.assign(sel.annotation, patch)
            drawAnnotation(sel.annotation)
            saveState()
            return sel.annotation
        }
        const value = view.getCFI(sel.index, sel.range)
        const a = {
            value, index: sel.index,
            color: 'yellow', style: 'highlight', note: '',
            text: sel.range.toString().trim(),
            chapter: view.getProgressOf(sel.index, sel.range)?.tocItem?.label?.trim() ?? '',
            created: Date.now(),
            ...patch,
        }
        state.annotations.push(a)
        drawAnnotation(a)
        view.deselect()
        saveState()
        sel.annotation = a
        return a
    }
    const openNote = () => {
        selPop.classList.add('noting')
        noteArea.value = sel?.annotation?.note ?? ''
        if (sel) placeSel(sel.range)
        setTimeout(() => noteArea.focus(), 30)
    }
    const commitNote = () => {
        if (!sel?.annotation) return
        const note = noteArea.value.trim()
        if (note !== (sel.annotation.note ?? '')) {
            sel.annotation.note = note
            saveState()
        }
    }
    selPop.addEventListener('mousedown', e => { if (e.target !== noteArea) e.preventDefault() })
    selPop.addEventListener('click', e => {
        const dot = e.target.closest('.dot')
        if (dot) {
            ensureAnnotation({ color: dot.dataset.color, style: 'highlight' })
            if (!selPop.classList.contains('noting')) hideSel()
            else showMarks()
            return
        }
        const act = e.target.closest('[data-sel]')?.dataset.sel
        if (!act || !sel) return
        if (act === 'underline') {
            ensureAnnotation({ style: 'underline' })
            if (!selPop.classList.contains('noting')) hideSel()
            else showMarks()
        } else if (act === 'note') {
            ensureAnnotation()
            showMarks()
            openNote()
        } else if (act === 'copy') {
            const text = sel.annotation?.text ?? sel.range.toString()
            copyText(text, sel.range.startContainer.ownerDocument)
            toast('已拷贝')
            view.deselect()
            hideSel()
        } else if (act === 'lookup') {
            call('lookUp', { text: (sel.annotation?.text ?? sel.range.toString()).trim().slice(0, 80) }).catch(() => {})
        } else if (act === 'find') {
            const text = sel.range.toString().trim().slice(0, 60)
            view.deselect()
            hideSel()
            openDrawer('search')
            searchInput.value = text
            runSearch(text)
        } else if (act === 'delete') {
            const value = sel.annotation?.value
            selPop.classList.remove('noting')
            sel = null
            selPop.classList.remove('show')
            if (value) removeAnnotation(value)
        }
    })
    const showMarks = () => {
        const a = sel?.annotation
        for (const d of $$('.dot', selPop))
            d.classList.toggle('on', !!a && a.style !== 'underline' && a.color === d.dataset.color)
        $('[data-sel="underline"]', selPop).classList.toggle('on', a?.style === 'underline')
        $('[data-sel="delete"]', selPop).style.display = a ? '' : 'none'
        $('[data-sel="find"]', selPop).style.display = a ? 'none' : ''
    }
    noteArea.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            e.preventDefault()
            hideSel()
        }
    })
    const copyText = (text, doc) => {
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => doc?.execCommand?.('copy'))
        else doc?.execCommand?.('copy')
    }

    // ── search ────────────────────────────────────────────────────
    let searchRun = 0, searchLinger = 0
    const runSearch = async query => {
        const run = ++searchRun
        query = query.trim()
        view?.clearSearch()
        if (!query) { searchResults.innerHTML = ''; return }
        searchResults.innerHTML = `<div class="search-status">正在搜索…</div>`
        const status = $('.search-status', searchResults)
        const frag = t => esc(t ?? '')
        let count = 0
        const { accent } = themeColors()
        try {
            for await (const result of view.search({
                query, defaultLocale: view.language?.canonical || 'zh',
                draw: Overlayer.outline, drawOptions: { color: accent, width: 1.5, radius: 3 },
            })) {
                if (run !== searchRun || !alive) return
                if (result === 'done') break
                if (result.progress != null) {
                    status.textContent = `正在搜索… ${Math.round(result.progress * 100)}%`
                    continue
                }
                if (!result.subitems?.length) continue
                count += result.subitems.length
                const group = h(`<div><div class="search-group">${esc(result.label?.trim() || '正文')}</div>${
                    result.subitems.slice(0, 200).map(s => `
                    <button class="search-hit" data-cfi="${esc(s.cfi)}">${frag(s.excerpt.pre)}<mark>${frag(s.excerpt.match)}</mark>${frag(s.excerpt.post)}</button>`).join('')}</div>`)
                searchResults.append(group)
            }
            status.textContent = count ? `共 ${count} 处` : `没有找到“${query}”`
        } catch (e) {
            console.error(e)
            status.textContent = '搜索出错了'
        }
    }
    searchInput.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Enter') runSearch(searchInput.value)
        else if (e.key === 'Escape') {
            if (searchInput.value) { searchInput.value = ''; runSearch('') }
            else closeDrawer()
        }
    })
    searchInput.addEventListener('input', debounce(() => {
        if (searchInput.value.trim().length >= 2 || !searchInput.value) runSearch(searchInput.value)
    }, 450))
    searchResults.addEventListener('click', e => {
        const b = e.target.closest('[data-cfi]')
        if (!b) return
        jump(b.dataset.cfi)
        closeDrawer({ keepSearch: true })
    })

    // ── settings popover ──────────────────────────────────────────
    const seg = (key, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, l]) =>
        `<button data-v="${v}" class="${String(settings[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`
    const slider = (key, min, max, step) =>
        `<input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${settings[key]}"
            style="--p:${(settings[key] - min) / (max - min) * 100}%">`
    const renderSettings = () => {
        settingsPop.innerHTML = `
            <div class="set-row"><div class="swatches">${THEMES.map(t =>
                `<button class="swatch${settings.theme === t.id ? ' on' : ''}" data-v="${t.id}" title="${t.name}">${t.id === 'auto' ? '' : t.name}</button>`).join('')}</div></div>
            <hr class="set-hr">
            <div class="text-only">
            <div class="set-row"><label>字体</label><div class="seg" data-key="font">${FONTS.map(f =>
                `<button data-v="${f.id}" class="${settings.font === f.id ? 'on' : ''}" style="font-family:${f.stack ? esc(f.stack) : 'inherit'}">${f.name}</button>`).join('')}
                <button data-more-fonts class="${settings.font === 'custom' ? 'on' : ''}" title="${esc(settings.customFont || '选择系统里安装的字体')}"
                    style="${settings.font === 'custom' ? `font-family:${esc(fontStack())}` : ''}">${settings.font === 'custom' && settings.customFont ? esc(settings.customFont) : '更多…'}</button></div></div>
            <div class="set-row"><label>字号</label>${slider('fontSize', 13, 30, 1)}<span class="val">${settings.fontSize}</span></div>
            <div class="set-row"><label>行距</label>${slider('lineHeight', 1.3, 2.4, 0.05)}<span class="val">${(+settings.lineHeight).toFixed(2)}</span></div>
            <div class="set-row"><label>版心</label>${slider('pageWidth', 440, 920, 20)}<span class="val">${settings.pageWidth}</span></div>
            <hr class="set-hr">
            <div class="set-row"><label>分栏</label>${seg('columns', [['auto', '自动'], ['1', '单栏'], ['2', '双栏']])}</div>
            <div class="set-row"><label>翻页</label>${seg('flow', [['paginated', '左右分页'], ['scrolled', '上下滚动']])}</div>
            <div class="set-row"><label>方向</label>${seg('writing', [['book', '原书'], ['horizontal', '横排'], ['vertical', '竖排']])}</div>
            <div class="set-toggles">
                <button class="toggle${settings.justify ? ' on' : ''}" data-toggle="justify">两端对齐</button>
                <button class="toggle${settings.indent ? ' on' : ''}" data-toggle="indent">首行缩进</button>
                <button class="toggle${settings.animated ? ' on' : ''}" data-toggle="animated">翻页动画</button>
            </div>
            </div>`
    }
    const closeSettings = () => {
        if (!settingsPop.classList.contains('show')) return
        settingsPop.classList.remove('show')
        scheduleHide(600)
    }
    const toggleSettings = () => {
        if (settingsPop.classList.contains('show')) return closeSettings()
        renderSettings()
        settingsPop.classList.add('show')
        el.classList.add('ui')
    }
    settingsPop.addEventListener('click', e => {
        const sw = e.target.closest('.swatch')
        if (sw) { updateSettings({ theme: sw.dataset.v }); renderSettings(); return }
        const tg = e.target.closest('[data-toggle]')
        if (tg) { updateSettings({ [tg.dataset.toggle]: !settings[tg.dataset.toggle] }); renderSettings(); return }
        const more = e.target.closest('[data-more-fonts]')
        if (more) { pickFont(more); return }
        const b = e.target.closest('.seg button')
        if (b) { updateSettings({ [b.parentElement.dataset.key]: b.dataset.v }); renderSettings() }
    })
    const pickFont = async anchor => {
        const families = await call('listFonts').catch(() => [])
        if (!families?.length) return toast('没有找到可用的中文字体')
        const r = anchor.getBoundingClientRect()
        showMenu(r.right, r.bottom + 6, families.map(family => ({
            label: family, checked: settings.font === 'custom' && settings.customFont === family,
            run: () => { updateSettings({ font: 'custom', customFont: family }); renderSettings() },
        })), { alignRight: true })
    }
    settingsPop.addEventListener('input', e => {
        const input = e.target
        if (input.type !== 'range') return
        const v = Number(input.value)
        input.style.setProperty('--p', (v - input.min) / (input.max - input.min) * 100 + '%')
        input.nextElementSibling.textContent = input.dataset.key === 'lineHeight' ? v.toFixed(2) : v
        updateSettings({ [input.dataset.key]: v })
    })
    el.addEventListener('pointerdown', e => {
        if (settingsPop.classList.contains('show') && !settingsPop.contains(e.target)
            && !e.target.closest('[data-act="settings"]') && !e.target.closest('.menu')) closeSettings()
        if (selPop.classList.contains('show') && !selPop.contains(e.target)) hideSel()
        if (noteCard.classList.contains('show') && !noteCard.contains(e.target)) closeNoteCard()
    }, true)

    cleanups.push(onSettings(patch => {
        if (!view) return
        if ('writing' in patch) return remount()
        if (['flow', 'pageWidth', 'columns', 'animated'].some(k => k in patch)) applyLayout()
        if (['theme', 'font', 'customFont', 'fontSize', 'lineHeight', 'justify', 'indent'].some(k => k in patch)) applyStyle()
        if ('theme' in patch) for (const a of state.annotations) if (a.style === 'underline') drawAnnotation(a)
    }))

    // ── footnotes & images ────────────────────────────────────────
    let footnotes
    const closeNoteCard = () => {
        noteCard.classList.remove('show')
        setTimeout(() => { if (!noteCard.classList.contains('show')) noteCard.replaceChildren() }, 250)
    }
    const setupFootnotes = async () => {
        const { FootnoteHandler } = await import(FOLIATE + 'footnotes.js')
        footnotes = new FootnoteHandler()
        footnotes.addEventListener('before-render', e => {
            // the note's own little view must be in the document to load at all
            noteCard.replaceChildren(e.detail.view)
            const r = e.detail.view.renderer
            r.setAttribute('flow', 'scrolled')
            r.setAttribute('margin', '14px')
            r.setAttribute('gap', '6%')
            r.setAttribute('max-inline-size', '520px')
            r.setStyles?.(readerCSS().replace(/font-size: \d+px !important/, m =>
                `font-size: ${Math.max(13, settings.fontSize - 3)}px !important`)
                .replace(/writing-mode:[^;]+;/g, ''))
        })
        footnotes.addEventListener('render', () => noteCard.classList.add('show'))
    }
    imageView.addEventListener('click', () => imageView.classList.remove('show'))

    // ── per-document wiring ───────────────────────────────────────
    let wheelLast = 0, wheelPrev = 0, overscroll = 0
    const onWheel = e => {
        if (!view || fxl && e.ctrlKey) return
        if (view.renderer?.scrolled) {
            // scrolling past either end of a chapter carries on into the next one
            const r = view.renderer, now = performance.now()
            if (Math.abs(e.deltaY) < Math.abs(e.deltaX) || now - wheelLast < 700) return
            const atEnd = r.viewSize - r.end <= 2, atStart = r.start <= 2
            if ((e.deltaY > 0 && atEnd) || (e.deltaY < 0 && atStart)) {
                overscroll += Math.abs(e.deltaY)
                if (overscroll > 160) {
                    overscroll = 0
                    wheelLast = now
                    e.deltaY > 0 ? next() : prev()
                }
            } else overscroll = 0
            return
        }
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        const mag = Math.abs(d), now = performance.now()
        const fresh = now - wheelLast > 480 || (mag > wheelPrev * 1.6 && now - wheelLast > 220)
        wheelPrev = mag
        if (mag < 8 || !fresh) return
        wheelLast = now
        const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
        if (horizontal) d > 0 ? right() : left()
        else d > 0 ? next() : prev()
    }
    const onKey = e => {
        if (e.defaultPrevented) return
        const tag = e.target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        const mod = e.metaKey || e.ctrlKey
        const k = e.key
        const done = () => { e.preventDefault(); e.stopPropagation() }
        if (mod && k === 'f') { done(); openDrawer('search') }
        else if (mod && k === 'd') { done(); toggleBookmark() }
        else if (mod && (k === '=' || k === '+')) { done(); updateSettings({ fontSize: clamp(settings.fontSize + 1, 13, 30) }) }
        else if (mod && k === '-') { done(); updateSettings({ fontSize: clamp(settings.fontSize - 1, 13, 30) }) }
        else if (mod && k === '[') { done(); view?.history.back() }
        else if (mod && k === ']') { done(); view?.history.forward() }
        else if (mod || e.altKey) return
        else if (k === 'Escape') {
            done()
            if (imageView.classList.contains('show')) imageView.classList.remove('show')
            else if (noteCard.classList.contains('show')) closeNoteCard()
            else if (selPop.classList.contains('show')) { view?.deselect(); hideSel() }
            else if (settingsPop.classList.contains('show')) closeSettings()
            else if (el.classList.contains('drawer')) closeDrawer()
            else close()
        }
        else if (k === 'ArrowLeft') { done(); left() }
        else if (k === 'ArrowRight') { done(); right() }
        else if (k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey) || k === 'j') {
            if (view?.renderer?.scrolled && (k === 'ArrowDown')) return
            done(); next()
        }
        else if (k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey) || k === 'k') {
            if (view?.renderer?.scrolled && (k === 'ArrowUp')) return
            done(); prev()
        }
        else if (k === 'Home') { done(); jump({ fraction: 0 }) }
        else if (k === 'End') { done(); jump({ fraction: 1 }) }
        else if (k === 't') { done(); el.classList.contains('drawer') ? closeDrawer() : openDrawer('toc') }
        else if (k === 'n') { done(); el.classList.contains('drawer') ? closeDrawer() : openDrawer('notes') }
        else if (k === '/') { done(); openDrawer('search') }
    }
    document.addEventListener('keydown', onKey, { signal })
    stage.addEventListener('wheel', onWheel, { passive: true })

    let suppressClick = 0
    const onDocLoad = ({ doc, index }) => {
        vertical = writingModeOf(doc).startsWith('vertical')
        if (!fxl) tuneDocument(doc)
        const frameOffset = () => doc.defaultView.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 }
        doc.addEventListener('keydown', onKey)
        doc.addEventListener('wheel', onWheel, { passive: true })
        doc.addEventListener('mousemove', e => pointerAt(e.clientY + frameOffset().top))
        doc.addEventListener('pointerdown', () => {
            if (selPop.classList.contains('show')) hideSel()
            if (settingsPop.classList.contains('show')) closeSettings()
            if (noteCard.classList.contains('show')) closeNoteCard()
        })

        const checkSelection = debounce(() => {
            const s = doc.getSelection()
            if (!s || s.isCollapsed || !s.rangeCount || !s.toString().trim()) {
                if (sel && !sel.annotation) hideSel()
                return
            }
            showSelFor(s.getRangeAt(0).cloneRange(), index)
        }, 160)
        doc.addEventListener('pointerup', checkSelection)
        doc.addEventListener('keyup', e => { if (e.shiftKey) checkSelection() })
        doc.addEventListener('selectionchange', () => {
            if (doc.getSelection()?.isCollapsed && sel && !sel.annotation) hideSel()
        })

        doc.addEventListener('dblclick', e => {
            const img = e.target.closest?.('img, image')
            const src = img?.currentSrc || img?.src || img?.href?.baseVal
            if (!src) return
            $('img', imageView).src = src
            imageView.classList.add('show')
        })

        // tap zones: left / right thirds turn pages, the middle toggles chrome
        doc.addEventListener('click', e => {
            if (e.defaultPrevented || e.button !== 0) return
            if (e.target.closest?.('a[href], audio, video, button, input')) return
            setTimeout(() => {
                if (performance.now() - suppressClick < 250) return
                if (!doc.getSelection()?.isCollapsed) return
                if (el.classList.contains('drawer')) return
                const x = e.clientX + frameOffset().left
                const w = innerWidth
                if (view.renderer?.scrolled) return toggleUI()
                if (x < w * 0.28) { unpinUI(); left() }
                else if (x > w * 0.72) { unpinUI(); right() }
                else toggleUI()
            })
        })
    }

    const onRelocate = detail => {
        location = detail
        const { fraction, tocItem, section, time } = detail
        const label = tocItem?.label?.trim() ?? ''
        const r = view.renderer
        const paged = !fxl && !r.scrolled && r.pages > 2
        $('.rd-run.head span', el).textContent = label && label !== meta.title ? label : ''
        $('.rd-run.foot .l', el).textContent = paged ? `本章 ${clamp(r.page, 1, r.pages - 2)} / ${r.pages - 2}` : ''
        $('.rd-run.foot .r', el).textContent = percent(fraction)
        scrub.value = fraction
        scrub.style.setProperty('--p', fraction * 100 + '%')
        $('.rd-scrub .l', el).textContent = label || meta.title
        $('.rd-scrub .r', el).textContent = fraction >= 0.999 ? '已读完'
            : time?.total > 0.5 ? `全书约剩 ${duration(time.total)}` : ''
        refreshBookmarkState()
        if (el.classList.contains('drawer')) renderTOC(false)

        const atEnd = fraction >= 0.995 || (section && section.current >= section.total - 1 && fraction > 0.97)
        state.progress = { cfi: detail.cfi, fraction, updated: Date.now() }
        if (atEnd) state.finished = true
        saveState()
    }
    scrub.addEventListener('input', () => {
        scrub.style.setProperty('--p', scrub.value * 100 + '%')
        scrubTo(Number(scrub.value))
    })
    const scrubTo = debounce(fraction => jump({ fraction }), 120)

    // ── mounting the book view ────────────────────────────────────
    const mountView = async lastLocation => {
        view = document.createElement('foliate-view')
        stage.replaceChildren(view)
        await view.open(book)
        fxl = view.isFixedLayout
        el.classList.toggle('fxl', fxl)
        view.addEventListener('load', e => onDocLoad(e.detail))
        view.addEventListener('relocate', e => onRelocate(e.detail))
        // The renderer says *why* the page moved. Once the reader turns pages
        // on their own, the "go back" offer and search outlines have done
        // their job.
        view.renderer.addEventListener('relocate', e => {
            const { reason } = e.detail
            if (reason !== 'page' && reason !== 'scroll' && reason !== 'snap') return
            chip.classList.remove('show')
            if (searchLinger > 0 && --searchLinger === 0) view.clearSearch()
        })
        view.addEventListener('create-overlay', e => {
            for (const a of state.annotations) if (a.index === e.detail.index) drawAnnotation(a)
        })
        view.addEventListener('draw-annotation', e => {
            const { draw, annotation, doc } = e.detail
            const color = HIGHLIGHTS[annotation.color] ?? HIGHLIGHTS.yellow
            if (annotation.style === 'underline')
                draw(Overlayer.underline, { color: themeColors().accent, width: 1.5, writingMode: writingModeOf(doc) })
            else draw(Overlayer.highlight, { color })
        })
        view.addEventListener('show-annotation', e => {
            const a = state.annotations.find(a => a.value === e.detail.value)
            if (!a) return
            suppressClick = performance.now()
            showSelFor(e.detail.range, e.detail.index, a)
        })
        view.addEventListener('link', e => {
            suppressClick = performance.now()
            const note = footnotes?.handle(book, e)
            if (note) {
                // if the note can't be shown in place, just follow the link
                note.catch(err => { console.warn(err); closeNoteCard(); jump(e.detail.href) })
                return
            }
            setTimeout(() => {
                if (!view.history.canGoBack) return
                chip.classList.add('show')
                clearTimeout(chipTimer)
                chipTimer = setTimeout(() => chip.classList.remove('show'), 9000)
            }, 300)
        })
        view.addEventListener('external-link', e => {
            e.preventDefault()
            call('openExternal', { url: e.detail.a.href }).catch(() => {})
        })
        applyLayout()
        applyStyle()
        await view.init({ lastLocation })
        view.renderer.focusView?.()
    }
    const remount = async () => {
        const cfi = location?.cfi ?? state.progress?.cfi
        hideSel()
        view?.close()
        view?.remove()
        await mountView(cfi)
    }

    const close = () => {
        saveState.flush()
        onClose()
    }

    el.addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act
        if (!act) return
        if (act === 'close') close()
        else if (act === 'toc') openDrawer('toc')
        else if (act === 'notes') openDrawer('notes')
        else if (act === 'search') openDrawer('search')
        else if (act === 'bookmark') toggleBookmark()
        else if (act === 'settings') toggleSettings()
    })
    el.addEventListener('mousedown', e => {
        if (e.target.matches('[data-drag]')) startWindowDrag(e)
    })

    const start = async () => {
        try {
            const [b, stored, viewModule, overlayerModule, cfiModule] = await Promise.all([
                openBook(id),
                call('getState', { id }).catch(() => null),
                import(FOLIATE + 'view.js'),
                import(FOLIATE + 'overlayer.js'),
                import(FOLIATE + 'epubcfi.js'),
            ])
            if (!alive) return
            void viewModule
            book = b
            Overlayer = overlayerModule.Overlayer
            CFI = cfiModule
            state = { annotations: [], bookmarks: [], ...(stored ?? {}) }
            state.annotations ??= []
            state.bookmarks ??= []

            meta = {
                title: cleanTitle(langMap(book.metadata?.title)) || '未命名',
                author: contributors(book.metadata?.author),
            }
            toc = flattenTOC(book.toc)
            $('.rd-bar-title b', el).textContent = meta.title
            $('.rd-bar-title span', el).textContent = meta.author
            document.title = meta.title
            call('setTitle', { title: meta.title }).catch(() => {})

            const head = $('.rd-book', el)
            head.innerHTML = `<div class="cover cloth" style="background:${clothColor(meta.title)}"><b>${esc(meta.title)}</b></div>
                <div><b>${esc(meta.title)}</b><span>${esc(meta.author)}</span></div>`
            Promise.resolve(book.getCover?.()).then(blob => {
                if (!blob || !alive) return
                const url = URL.createObjectURL(blob)
                cleanups.push(() => URL.revokeObjectURL(url))
                $('.cover', head).outerHTML = `<div class="cover"><img src="${url}" alt=""></div>`
            }).catch(() => {})

            setupFootnotes().catch(console.error)
            // a finished book reopens from the start rather than its last page
            const resume = state.finished && state.progress?.fraction >= 0.995 ? null : state.progress?.cfi
            await mountView(resume)
            if (!alive) return
            loading.classList.add('done')
            if (noHover.matches) showUI(true, 2200)
        } catch (e) {
            console.error(e)
            if (!alive) return
            loading.innerHTML = `<div class="err">这本书打不开。<br><small>${esc(e?.message ?? e)}</small><br>
                <button class="btn quiet" data-act="close">返回书库</button></div>`
            el.classList.add('ui')
            uiPinned = true
        }
    }
    start()

    return () => {
        alive = false
        saveState.flush()
        for (const f of cleanups) f()
        try { view?.close() } catch { /* already gone */ }
        document.title = 'Inkstone'
    }
}

export { isNative }
