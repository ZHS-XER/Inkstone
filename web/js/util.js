export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

export const h = (html) => {
    const t = document.createElement('template')
    t.innerHTML = html.trim()
    return t.content.firstElementChild
}

export const debounce = (f, ms) => {
    let t
    const g = (...args) => {
        clearTimeout(t)
        t = setTimeout(() => f(...args), ms)
    }
    g.flush = (...args) => { clearTimeout(t); f(...args) }
    return g
}

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x))

export const percent = x => {
    if (x == null || Number.isNaN(x)) return ''
    const p = x * 100
    return (p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)) + '%'
}

export const relativeTime = ts => {
    if (!ts) return ''
    const s = (Date.now() - ts) / 1000
    if (s < 60) return '刚刚'
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
    const d = new Date(ts), now = new Date()
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate())
        - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5)
    if (days === 0) return `${Math.floor(s / 3600)} 小时前`
    if (days === 1) return '昨天'
    if (days < 30) return `${days} 天前`
    return d.getFullYear() === now.getFullYear()
        ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
        : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
}

export const duration = minutes => {
    if (!Number.isFinite(minutes)) return ''
    if (minutes < 1) return '不到 1 分钟'
    if (minutes < 60) return `${Math.round(minutes)} 分钟`
    const hr = Math.floor(minutes / 60), m = Math.round(minutes % 60)
    return m ? `${hr} 小时 ${m} 分钟` : `${hr} 小时`
}

let toastTimer
export const toast = msg => {
    const el = $('#toast')
    el.textContent = msg
    el.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

const hashCode = s => {
    let x = 0
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0
    return Math.abs(x)
}
// muted cloth-binding colours for books without a cover
const CLOTH = ['#B5654A', '#7A8B6F', '#5F7389', '#B08D57', '#7D6079', '#4F5B57', '#9A5B5B', '#6B6A8C']
export const clothColor = s => CLOTH[hashCode(s) % CLOTH.length]

// Store listings stuff titles with sales copy — "书名【出版社出品！…】（套装）".
// Show the title a person would actually say.
const BLURB = /出品|经典|译本|译文|作品|代表作|套装|全集|全新|新版|修订|精装|首发|文库|丛刊|丛书|系列|讲演集|畅销|豆瓣|诺贝尔|\d{4}/
export const cleanTitle = title => {
    const strip = s => s
        .replace(/【[^】]*】/g, '')
        .replace(/[（(\[]([^（()）\[\]]*)[)）\]]/g, (m, inner) => inner.length >= 10 || BLURB.test(inner) ? '' : m)
    let t = strip(strip(String(title ?? ''))).replace(/\s{2,}/g, ' ').trim()
    t = t.replace(/[\s\-—:：·,，]+$/, '')
    return t.length >= 1 ? t : String(title ?? '')
}

// language-map / contributor helpers for EPUB metadata
export const langMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    return x[Object.keys(x)[0]] ?? ''
}
export const contributors = x => {
    const one = c => typeof c === 'string' ? c : langMap(c?.name)
    return (Array.isArray(x) ? x.map(one) : [one(x)]).filter(Boolean).join('、')
}
