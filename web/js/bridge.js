// Thin bridge to the host. Inside the native app, calls go through a
// WKScriptMessageHandlerWithReply; in a plain browser (dev) they go to
// dev/server.mjs over HTTP. Resource reads (/api/library, /book/…, /cover/…)
// are ordinary same-origin fetches in both cases.
const handler = globalThis.webkit?.messageHandlers?.inkstone

export const isNative = !!handler
// 'mac', 'ios iphone', 'ios ipad' or 'web'; each word becomes a class on <html>
export const platform = globalThis.__inkstonePlatform ?? 'web'
export const isMac = platform === 'mac'
export const isIOS = platform.startsWith('ios')

export const call = async (method, params = {}) => {
    if (handler) {
        // WebKit preserves object identity when it converts the reply, and
        // Foundation's empty arrays are one shared singleton — so two empty
        // lists would arrive as the *same* JS array. Round-trip through JSON
        // to get plain, unshared data.
        const reply = await handler.postMessage({ method, params })
        return reply == null ? reply : JSON.parse(JSON.stringify(reply))
    }
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
