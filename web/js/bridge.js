// Thin bridge to the host. Inside the native app, calls go through a
// WKScriptMessageHandlerWithReply; in a plain browser (dev) they go to
// dev/server.mjs over HTTP. Resource reads (/api/library, /book/…, /cover/…)
// are ordinary same-origin fetches in both cases.
const handler = globalThis.webkit?.messageHandlers?.inkstone

export const isNative = !!handler
export const platform = globalThis.__inkstonePlatform ?? 'web' // 'mac' | 'ios' | 'web'

export const call = async (method, params = {}) => {
    if (handler) return handler.postMessage({ method, params })
    const res = await fetch('/api/call', {
        method: 'POST',
        body: JSON.stringify({ method, params }),
    })
    if (!res.ok) throw new Error(`${method}: ${res.status}`)
    return (await res.json()).result
}

export const getJSON = async url => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: ${res.status}`)
    return res.json()
}

// Host → web events: the native side evaluates `__inkstone.emit(name, detail)`.
const target = new EventTarget()
globalThis.__inkstone = {
    emit: (name, detail) => target.dispatchEvent(new CustomEvent(name, { detail })),
}
export const onHost = (name, f) => {
    const listener = e => f(e.detail)
    target.addEventListener(name, listener)
    return () => target.removeEventListener(name, listener)
}
