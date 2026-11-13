// Development server: mimics the native bridge (see Sources/InkstoneCore) so the
// web UI can be developed and tested in an ordinary browser.
//
//   node dev/server.mjs [port]
//
// Books are read from the Apple Books iCloud folder and from dev/books/ (zip
// .epub files are unpacked to a temp dir with `unzip`).
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const PORT = Number(process.argv[2] || process.env.PORT || 4173)
const APPLE = path.join(os.homedir(),
    'Library/Mobile Documents/iCloud~com~apple~iBooks/Documents')
const LOCAL = path.join(ROOT, 'dev/books')
const DATA = path.join(ROOT, 'dev/.data')
const TMP = path.join(os.tmpdir(), 'inkstone-dev')
for (const d of [LOCAL, DATA, path.join(DATA, 'state'), TMP])
    fs.mkdirSync(d, { recursive: true })

const MIME = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    xhtml: 'application/xhtml+xml', xml: 'application/xml',
    opf: 'application/oebps-package+xml', ncx: 'application/x-dtbncx+xml',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf',
    woff: 'font/woff', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8',
}
const mime = p => MIME[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream'
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

const books = new Map() // id -> { id, dir, source, title, author, coverPath, added }

const decodeXML = s => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCodePoint(parseInt(d, 16)))
    .replace(/&amp;/g, '&')

const readMeta = dir => {
    const container = fs.readFileSync(path.join(dir, 'META-INF/container.xml'), 'utf8')
    const opfPath = decodeXML(container.match(/full-path="([^"]+)"/)[1])
    const opf = fs.readFileSync(path.join(dir, opfPath), 'utf8')
    const tag = name => {
        const m = opf.match(new RegExp(`<dc:${name}[^>]*>([\\s\\S]*?)</dc:${name}>`))
        return m ? decodeXML(m[1].replace(/<[^>]+>/g, '')).trim() : ''
    }
    const items = [...opf.matchAll(/<item\b[^>]*>/g)].map(m => {
        const attr = n => m[0].match(new RegExp(`\\b${n}="([^"]*)"`))?.[1]
        return { id: attr('id'), href: attr('href'), type: attr('media-type'), props: attr('properties') }
    })
    const metaCover = opf.match(/<meta\b[^>]*name="cover"[^>]*content="([^"]*)"/)?.[1]
        ?? opf.match(/<meta\b[^>]*content="([^"]*)"[^>]*name="cover"/)?.[1]
    const cover = items.find(i => i.props?.split(' ').includes('cover-image'))
        ?? items.find(i => i.id === metaCover)
        ?? items.find(i => /cover/i.test(i.id ?? '') && i.type?.startsWith('image/'))
    const coverPath = cover?.href
        ? path.join(path.dirname(opfPath), decodeURIComponent(decodeXML(cover.href)))
        : null
    return { title: tag('title'), author: tag('creator'), language: tag('language'), coverPath }
}

const scan = () => {
    books.clear()
    const add = (dir, source, name) => {
        try {
            const st = fs.statSync(dir)
            const meta = readMeta(dir)
            const id = hash(source + ':' + name)
            books.set(id, {
                id, dir, source, fileName: name.replace(/\.epub$/i, ''),
                title: meta.title || name.replace(/\.epub$/i, ''),
                author: meta.author, language: meta.language,
                coverPath: meta.coverPath, added: st.birthtimeMs,
            })
        } catch (e) {
            console.warn('skip', name, e.message)
        }
    }
    if (fs.existsSync(APPLE)) for (const name of fs.readdirSync(APPLE)) {
        if (!/\.epub$/i.test(name)) continue
        const p = path.join(APPLE, name)
        if (fs.statSync(p).isDirectory()) add(p, 'apple', name)
    }
    for (const name of fs.readdirSync(LOCAL)) {
        if (!/\.epub$/i.test(name)) continue
        const p = path.join(LOCAL, name)
        let dir = p
        if (!fs.statSync(p).isDirectory()) {
            dir = path.join(TMP, hash(p))
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
                try { execFileSync('unzip', ['-qq', '-o', p, '-d', dir]) } catch { /* partial ok */ }
            }
        }
        add(dir, 'local', name)
    }
}

const walk = async (dir, base = '') => {
    const out = {}
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
        const rel = base ? base + '/' + ent.name : ent.name
        if (ent.isDirectory()) Object.assign(out, await walk(path.join(dir, ent.name), rel))
        else out[rel] = (await fsp.stat(path.join(dir, ent.name))).size
    }
    return out
}

const readJSON = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
const stateFile = id => path.join(DATA, 'state', id.replace(/[^\w-]/g, '') + '.json')

const calls = {
    getState: ({ id }) => readJSON(stateFile(id), {}),
    saveState: ({ id, state }) => (fs.writeFileSync(stateFile(id), JSON.stringify(state)), true),
    getSettings: () => readJSON(path.join(DATA, 'settings.json'), {}),
    saveSettings: ({ settings }) =>
        (fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify(settings)), true),
    importBooks: () => ({ imported: 0 }),
    removeBook: () => false,
    exportText: ({ name, text }) => (fs.writeFileSync(path.join(DATA, name), text), true),
    openExternal: () => true,
    revealBook: () => true,
    setTitle: () => true,
    refreshLibrary: () => (scan(), true),
    setAppearance: () => true,
    setChrome: () => true,
    lookUp: () => true,
    dragWindow: () => true,
    zoomWindow: () => true,
    listFonts: () => ['Songti SC', 'Kaiti SC', 'PingFang SC', 'LXGW WenKai'],
}

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body)
}
const sendFile = (res, file) => {
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return send(res, 404, 'not found')
        res.writeHead(200, { 'Content-Type': mime(file), 'Content-Length': st.size, 'Cache-Control': 'no-store' })
        fs.createReadStream(file).pipe(res)
    })
}
const inside = (root, p) => {
    const r = path.resolve(root, p)
    return r === root || r.startsWith(root + path.sep) ? r : null
}

http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://x')
        const p = decodeURIComponent(url.pathname)
        if (p === '/api/library') {
            const list = [...books.values()].map(b => {
                const st = readJSON(stateFile(b.id), {})
                return {
                    id: b.id, title: b.title, author: b.author, source: b.source,
                    fileName: b.fileName, language: b.language,
                    hasCover: !!b.coverPath, added: b.added,
                    fraction: st.progress?.fraction ?? null,
                    lastRead: st.progress?.updated ?? null,
                    finished: !!st.finished,
                }
            })
            return send(res, 200, JSON.stringify({ books: list }), MIME.json)
        }
        if (p === '/api/call' && req.method === 'POST') {
            let body = ''
            for await (const chunk of req) body += chunk
            const { method, params } = JSON.parse(body)
            if (!calls[method]) return send(res, 404, 'no such method')
            return send(res, 200, JSON.stringify({ result: await calls[method](params ?? {}) }), MIME.json)
        }
        let m
        if ((m = p.match(/^\/api\/entries\/([\w-]+)$/))) {
            const b = books.get(m[1])
            if (!b) return send(res, 404, 'no book')
            return send(res, 200, JSON.stringify(await walk(b.dir)), MIME.json)
        }
        if ((m = p.match(/^\/cover\/([\w-]+)$/))) {
            const b = books.get(m[1])
            const f = b?.coverPath && inside(b.dir, b.coverPath)
            return f ? sendFile(res, f) : send(res, 404, 'no cover')
        }
        if ((m = p.match(/^\/book\/([\w-]+)\/(.+)$/))) {
            const b = books.get(m[1])
            const f = b && inside(b.dir, m[2])
            return f ? sendFile(res, f) : send(res, 404, 'not found')
        }
        const f = inside(WEB, '.' + (p === '/' ? '/index.html' : p))
        return f ? sendFile(res, f) : send(res, 403, 'forbidden')
    } catch (e) {
        console.error(e)
        send(res, 500, String(e))
    }
}).listen(PORT, '127.0.0.1', () => {
    scan()
    console.log(`Inkstone dev server: http://127.0.0.1:${PORT}  (${books.size} books)`)
})
