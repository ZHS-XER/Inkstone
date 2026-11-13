// Small pieces of window chrome shared by the library and the reader.
import { call, isNative } from './bridge.js'
import { icons } from './icons.js'
import { esc, h } from './util.js'

// The native window has no title bar of its own; empty areas of our top bars
// act as one. Double-click zooms, like a real title bar.
export const startWindowDrag = e => {
    if (!isNative || e.button !== 0) return
    e.preventDefault()
    call(e.detail >= 2 ? 'zoomWindow' : 'dragWindow').catch(() => {})
}

let closeCurrent = null

// items: [{ label, run, checked?, danger? } | '-' | falsy]
export const showMenu = (x, y, items, { alignRight = false } = {}) => {
    closeCurrent?.()
    items = items.filter(Boolean)
    while (items.at(-1) === '-') items.pop()
    const el = h(`<div class="menu" role="menu">${items.map((it, i) => it === '-' ? '<hr>'
        : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">
               <span>${esc(it.label)}</span>${it.checked ? `<span class="check">${icons.check}</span>` : ''}
           </button>`).join('')}</div>`)
    document.body.append(el)
    const { width, height } = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(alignRight ? x - width : x, innerWidth - width - 8))
    const top = Math.max(8, Math.min(y, innerHeight - height - 8))
    Object.assign(el.style, { left: left + 'px', top: top + 'px' })

    const close = () => {
        el.remove()
        document.removeEventListener('pointerdown', onDown, true)
        document.removeEventListener('keydown', onKey, true)
        removeEventListener('blur', close)
        if (closeCurrent === close) closeCurrent = null
    }
    const onDown = e => { if (!el.contains(e.target)) close() }
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    el.addEventListener('click', e => {
        const b = e.target.closest('button')
        if (!b) return
        close()
        items[b.dataset.i].run?.()
    })
    setTimeout(() => {
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        addEventListener('blur', close)
    })
    closeCurrent = close
    return close
}
