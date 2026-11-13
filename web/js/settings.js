import { call } from './bridge.js'
import { debounce } from './util.js'

export const THEMES = [
    { id: 'auto', name: '自动' },
    { id: 'paper', name: '纸' },
    { id: 'white', name: '素' },
    { id: 'sepia', name: '笺' },
    { id: 'dusk', name: '黛', dark: true },
    { id: 'ink', name: '墨', dark: true },
]

// Latin faces come first so that Western text never falls back to the CJK
// font's (usually clumsy) Latin glyphs.
export const FONTS = [
    { id: 'book', name: '原书', stack: null, sample: 'inherit' },
    { id: 'song', name: '宋体', stack: '"Iowan Old Style", "Palatino", Georgia, "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", STSong, serif' },
    { id: 'kai', name: '楷体', stack: '"Iowan Old Style", "Palatino", Georgia, "LXGW WenKai", "Kaiti SC", STKaiti, KaiTi, serif' },
    { id: 'fang', name: '仿宋', stack: '"Iowan Old Style", "Palatino", Georgia, STFangsong, "FangSong SC", FangSong, serif' },
    { id: 'hei', name: '黑体', stack: '"Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif' },
]

// the font stack for the current settings; null means "leave the book alone"
export const fontStack = (s = settings) => {
    if (s.font === 'custom') return s.customFont ? `"${s.customFont.replace(/["\\]/g, '')}", "Songti SC", serif` : null
    return FONTS.find(f => f.id === s.font)?.stack ?? null
}

export const DEFAULTS = {
    theme: 'auto',
    font: 'song',
    customFont: '',      // family name, used when font === 'custom'
    fontSize: 18,
    lineHeight: 1.75,
    pageWidth: 680,      // max column width, px
    columns: 'auto',     // auto | 1 | 2
    flow: 'paginated',   // paginated | scrolled
    writing: 'book',     // book | horizontal | vertical
    justify: true,
    indent: false,
    animated: true,
    sort: 'recent',
}

export const settings = { ...DEFAULTS }
const listeners = new Set()
const dark = matchMedia('(prefers-color-scheme: dark)')

export const resolvedTheme = () =>
    settings.theme === 'auto' ? (dark.matches ? 'dusk' : 'paper') : settings.theme

const applyTheme = () => {
    const id = resolvedTheme()
    const root = document.documentElement
    root.dataset.theme = id
    root.classList.toggle('dark', !!THEMES.find(t => t.id === id)?.dark)
    call('setAppearance', { dark: root.classList.contains('dark') }).catch(() => {})
}

// read the active theme's colours back from CSS (single source of truth)
export const themeColors = () => {
    const cs = getComputedStyle(document.documentElement)
    const v = name => cs.getPropertyValue(name).trim()
    return {
        bg: v('--bg'), fg: v('--fg'), fg2: v('--fg-2'), accent: v('--accent'),
        dark: document.documentElement.classList.contains('dark'),
    }
}

const save = debounce(() => call('saveSettings', { settings }).catch(console.error), 300)

export const initSettings = async () => {
    try {
        const stored = await call('getSettings')
        for (const k of Object.keys(DEFAULTS))
            if (stored?.[k] !== undefined) settings[k] = stored[k]
    } catch (e) {
        console.warn(e)
    }
    applyTheme()
    dark.addEventListener('change', () => {
        if (settings.theme !== 'auto') return
        applyTheme()
        for (const f of listeners) f({ theme: settings.theme })
    })
}

export const updateSettings = patch => {
    Object.assign(settings, patch)
    if ('theme' in patch) applyTheme()
    save()
    for (const f of listeners) f(patch)
}

export const onSettings = f => {
    listeners.add(f)
    return () => listeners.delete(f)
}
