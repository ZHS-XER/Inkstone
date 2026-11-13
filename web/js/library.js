import { call, getJSON, onHost, isNative } from './bridge.js'
import { settings, updateSettings } from './settings.js'
import { icons } from './icons.js'
import { $, esc, h, percent, relativeTime, clothColor, cleanTitle, toast } from './util.js'
import { startWindowDrag, showMenu } from './chrome.js'

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const cnToNumber = s => {
    if (/^\d+$/.test(s)) return Number(s)
    let total = 0, cur = 0
    for (const ch of s) {
        if (ch === '十') { total += (cur || 1) * 10; cur = 0 }
        else if (ch === '百') { total += (cur || 1) * 100; cur = 0 }
        else if (ch in CN_NUM) cur = CN_NUM[ch]
        else return NaN
    }
    return total + cur
}

// "无职转生 ～…～ 12" → { name: "无职转生 ～…～", vol: 12 }
// Returns null for titles that don't look like a volume of a series.
const VOLUME = new RegExp([
    '^(.{2,}?)[\\s\\-_:：·,，]*',
    '(?:',
    '(?:第\\s*)?([0-9]{1,3}(?:\\.[0-9])?|[零〇一二两三四五六七八九十百]{1,4})\\s*[卷册冊部集]?',
    '|[（(\\[【]\\s*([0-9]{1,3}|[上中下])\\s*[)）\\]】]',
    '|(?:vol(?:ume)?\\.?|卷)\\s*([0-9]{1,3})',
    '|(special\\s*book|特典|番外|短篇集?|外传|外傳)',
    ')\\s*$',
].join(''), 'i')

export const parseSeries = title => {
    const t = title.normalize('NFKC').trim()
    const m = t.match(VOLUME)
    if (!m) return null
    const name = m[1].trim().replace(/[\s\-_:：·,，]+$/, '')
    if (name.length < 2) return null
    let vol
    if (m[5]) vol = 1e6
    else {
        const raw = m[2] ?? m[3] ?? m[4]
        vol = { 上: 1, 中: 2, 下: 3 }[raw] ?? cnToNumber(raw)
        if (Number.isNaN(vol)) return null
    }
    return { name, key: name.replace(/[\s~～\-—_·:：,，.。!！?？]/g, '').toLowerCase(), vol }
}

const coverHTML = book => book.hasCover
    ? `<div class="cover"><img loading="lazy" decoding="async" src="/cover/${book.id}" alt="" data-fallback="${esc(book.title)}|${esc(book.author)}"></div>`
    : clothHTML(book.title, book.author)

const clothHTML = (title, author) =>
    `<div class="cover cloth" style="background:${clothColor(title)}"><b>${esc(title)}</b><span>${esc(author)}</span></div>`

export const mountLibrary = (root, { onOpen }) => {
    let books = []
    let filter = 'all'
    let query = ''
    let series = null // key of the series being browsed
    let destroyed = false

    const el = h(`
    <div class="library">
        <div class="lib-bar" data-drag>
            <div class="spacer" data-drag></div>
            <label class="lib-search">${icons.search}<input type="search" placeholder="搜索书名或作者" spellcheck="false"></label>
            <button class="icon-btn" data-act="sort" title="排序">${icons.sort}</button>
            <button class="icon-btn" data-act="import" title="导入 EPUB（⌘O）">${icons.plus}</button>
        </div>
        <div class="lib-scroll"><div class="lib-inner"></div></div>
    </div>`)
    root.replaceChildren(el)
    const inner = $('.lib-inner', el)
    const input = $('input', el)

    const annotate = () => {
        const groups = new Map()
        for (const b of books) {
            b.fullTitle = b.fullTitle ?? b.title
            b.title = cleanTitle(b.fullTitle)
            b.series = parseSeries(b.title) ?? parseSeries(b.fileName ?? '')
            if (!b.series) continue
            const g = groups.get(b.series.key) ?? { key: b.series.key, name: b.series.name, books: [] }
            g.books.push(b)
            groups.set(b.series.key, g)
        }
        for (const [key, g] of groups) {
            if (g.books.length < 2) {
                for (const b of g.books) b.series = null
                groups.delete(key)
            } else g.books.sort((a, b) => a.series.vol - b.series.vol || collator.compare(a.title, b.title))
        }
        return groups
    }
    let groups = new Map()

    const sorters = {
        recent: (a, b) => (b.lastRead ?? 0) - (a.lastRead ?? 0) || b.added - a.added,
        title: (a, b) => collator.compare(a.title, b.title),
        author: (a, b) => collator.compare(a.author || '￿', b.author || '￿') || collator.compare(a.title, b.title),
        added: (a, b) => b.added - a.added,
    }

    const status = b => b.finished
        ? `<div class="s done">已读完</div>`
        : b.fraction != null && b.fraction > 0.001
            ? `<div class="s"><div class="bar"><i style="width:${b.fraction * 100}%"></i></div>${percent(b.fraction)}</div>`
            : ''

    const bookTile = b => `
        <button class="book" data-id="${b.id}" title="${esc(b.fullTitle)}">
            <div class="cover-wrap">${coverHTML(b)}</div>
            <div class="t">${esc(b.title)}</div>
            <div class="a">${esc(b.author)}</div>
            ${status(b)}
        </button>`

    const seriesTile = g => {
        const lead = g.books.find(b => !b.finished && b.fraction > 0) ?? g.books[0]
        const done = g.books.filter(b => b.finished).length
        return `
        <button class="book series" data-series="${esc(g.key)}">
            <div class="cover-wrap">${coverHTML(lead)}<span class="badge">${g.books.length}</span></div>
            <div class="t">${esc(g.name)}</div>
            <div class="a">${esc(lead.author)}</div>
            ${done ? `<div class="s${done === g.books.length ? ' done' : ''}">已读 ${done} / ${g.books.length} 册</div>` : ''}
        </button>`
    }

    const render = () => {
        if (destroyed) return
        const q = query.trim().toLowerCase()
        const g = series ? groups.get(series) : null
        if (series && !g) series = null

        let list = g ? [...g.books] : [...books]
        if (q) list = list.filter(b => (b.title + ' ' + b.author).toLowerCase().includes(q))
        if (filter === 'reading') list = list.filter(b => !b.finished && b.fraction > 0.001)
        else if (filter === 'unread') list = list.filter(b => !b.finished && !(b.fraction > 0.001))
        else if (filter === 'finished') list = list.filter(b => b.finished)
        if (!g) list.sort(sorters[settings.sort] ?? sorters.recent)

        // collapse series into stacks on the unfiltered shelf
        let tiles
        if (!g && !q && filter === 'all') {
            const seen = new Set()
            tiles = []
            for (const b of list) {
                if (!b.series) tiles.push(bookTile(b))
                else if (!seen.has(b.series.key)) {
                    seen.add(b.series.key)
                    tiles.push(seriesTile(groups.get(b.series.key)))
                }
            }
        } else tiles = list.map(bookTile)

        const reading = !g && !q && filter === 'all'
            ? books.filter(b => b.lastRead && !b.finished && b.fraction > 0.001)
                .sort((a, b) => b.lastRead - a.lastRead).slice(0, 3)
            : []

        const seg = [['all', '全部'], ['reading', '在读'], ['unread', '未读'], ['finished', '读完']]
            .map(([v, l]) => `<button data-filter="${v}" class="${filter === v ? 'on' : ''}">${l}</button>`).join('')

        const head = g
            ? `<button class="crumb" data-act="shelf">书库</button><h1>${esc(g.name)}</h1><span class="count">${g.books.length} 册</span>`
            : `<h1>书库</h1><span class="count">${books.length ? books.length + ' 本' : ''}</span>`

        const body = !books.length
            ? `<div class="empty"><h2>书架还是空的</h2><p>${isNative ? '把 EPUB 文件拖进窗口，或者从这里导入。' : '没有找到任何 EPUB。'}</p>
               <button class="btn" data-act="import">${icons.plus}导入 EPUB</button></div>`
            : !tiles.length
                ? `<div class="empty"><p>${q ? `没有找到与“${esc(query)}”相关的书` : '这里暂时没有书'}</p></div>`
                : `<div class="grid">${tiles.join('')}</div>`

        inner.innerHTML = `
            <div class="lib-title">${head}<div class="seg">${seg}</div></div>
            ${reading.length ? `
            <section class="continue">
                <h2 class="section-label">继续阅读</h2>
                <div class="continue-row">${reading.map(b => `
                    <button class="continue-card" data-id="${b.id}">
                        ${coverHTML(b)}
                        <div class="meta">
                            <div class="t">${esc(b.title)}</div>
                            <div class="a">${esc(b.author)}</div>
                            <div class="p">
                                <div class="p-text"><span>${relativeTime(b.lastRead)}</span><span>${percent(b.fraction)}</span></div>
                                <div class="bar"><i style="width:${b.fraction * 100}%"></i></div>
                            </div>
                        </div>
                    </button>`).join('')}
                </div>
            </section>
            <h2 class="section-label">全部藏书</h2>` : ''}
            ${body}`
    }

    const load = async () => {
        try {
            books = (await getJSON('/api/library')).books
        } catch (e) {
            console.error(e)
            books = []
        }
        groups = annotate()
        render()
    }

    // a broken or missing cover image falls back to a cloth binding
    inner.addEventListener('error', e => {
        const img = e.target
        if (img.tagName !== 'IMG' || !img.dataset.fallback) return
        const [title, author] = img.dataset.fallback.split('|')
        img.closest('.cover').outerHTML = clothHTML(title, author ?? '')
    }, true)

    const setFinished = async (book, finished) => {
        const state = await call('getState', { id: book.id }) ?? {}
        state.finished = finished
        if (!finished && state.progress?.fraction > 0.99) delete state.progress
        await call('saveState', { id: book.id, state })
        load()
    }

    const bookMenu = (book, x, y) => showMenu(x, y, [
        { label: '打开', run: () => onOpen(book.id) },
        book.finished
            ? { label: '标记为未读完', run: () => setFinished(book, false) }
            : { label: '标记为已读完', run: () => setFinished(book, true) },
        isNative && { label: '在访达中显示', run: () => call('revealBook', { id: book.id }) },
        book.source === 'local' && '-',
        book.source === 'local' && {
            label: '从书库移除', danger: true,
            run: async () => {
                await call('removeBook', { id: book.id })
                toast('已移除')
                load()
            },
        },
    ])

    el.addEventListener('click', e => {
        const t = e.target.closest('[data-id], [data-series], [data-filter], [data-act]')
        if (!t) return
        if (t.dataset.id) onOpen(t.dataset.id)
        else if (t.dataset.series) {
            series = t.dataset.series
            filter = 'all'
            render()
            $('.lib-scroll', el).scrollTop = 0
        } else if (t.dataset.filter) {
            filter = t.dataset.filter
            render()
        } else if (t.dataset.act === 'shelf') {
            series = null
            render()
        } else if (t.dataset.act === 'import') {
            call('importBooks').then(r => {
                if (r?.imported) toast(`已导入 ${r.imported} 本`)
                load()
            })
        } else if (t.dataset.act === 'sort') {
            const r = t.getBoundingClientRect()
            const item = (v, label) => ({
                label, checked: settings.sort === v,
                run: () => { updateSettings({ sort: v }); render() },
            })
            showMenu(r.right, r.bottom + 6, [
                item('recent', '最近阅读'), item('title', '书名'),
                item('author', '作者'), item('added', '添加时间'),
            ], { alignRight: true })
        }
    })
    el.addEventListener('contextmenu', e => {
        const t = e.target.closest('[data-id]')
        if (!t) return
        e.preventDefault()
        const book = books.find(b => b.id === t.dataset.id)
        if (book) bookMenu(book, e.clientX, e.clientY)
    })
    el.addEventListener('mousedown', e => {
        if (e.target.matches('[data-drag]')) startWindowDrag(e)
    })
    input.addEventListener('input', () => { query = input.value; render() })
    const onKey = e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); input.focus(); input.select() }
        else if (e.key === 'Escape') {
            if (document.activeElement === input) { input.value = ''; query = ''; input.blur(); render() }
            else if (series) { series = null; render() }
        }
    }
    document.addEventListener('keydown', onKey)
    const off = onHost('library-changed', load)

    load()
    return () => {
        destroyed = true
        document.removeEventListener('keydown', onKey)
        off()
    }
}
