// Everything that shapes how a book's own pages look: the stylesheet injected
// into each section, and a light per-document pass that marks paragraphs the
// stylesheet should leave alone.
import { fontStack, settings, themeColors } from './settings.js'
import { fontFaceCSS } from './bridge.js'

export const HIGHLIGHTS = {
    yellow: '#EFC34A',
    coral: '#E38B6C',
    green: '#8DB67E',
    blue: '#7AA7D6',
    violet: '#B291CC',
}

export const readerCSS = () => {
    const s = settings
    const { bg, fg, accent, dark } = themeColors()
    const font = fontStack(s)
    const writing = s.writing === 'vertical' ? 'vertical-rl'
        : s.writing === 'horizontal' ? 'horizontal-tb' : null
    const tuned = 'html:not([data-ink-measuring])'
    return `
@namespace epub "http://www.idpf.org/2007/ops";
${fontFaceCSS}
html {
    color-scheme: ${dark ? 'dark' : 'light'};
    color: ${fg} !important;
    background: ${bg} !important;
    font-size: ${s.fontSize}px !important;
    ${writing ? `writing-mode: ${writing} !important;` : ''}
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    font-kerning: normal;
    /* CJK niceties: strict kinsoku, squeezed punctuation, Han–Latin spacing */
    line-break: strict;
    text-spacing-trim: trim-start;
    text-autospace: normal;
    hanging-punctuation: allow-end;
    orphans: 2; widows: 2;
}
body {
    color: inherit !important;
    background: none !important;
    font-size: 1rem !important;
    line-height: ${s.lineHeight} !important;
    ${writing ? `writing-mode: ${writing} !important;` : ''}
    ${font ? `font-family: ${font} !important;` : ''}
}
${font ? `body :not(pre, code, kbd, samp, pre *, svg, svg *, math, math *) { font-family: ${font} !important; }` : ''}
p, li, blockquote, dd, div {
    line-height: ${s.lineHeight} !important;
}
${s.justify ? `${tuned} :is(p, li, blockquote, dd):not([data-ink-keep]) {
    text-align: justify !important;
    -webkit-hyphens: auto; hyphens: auto;
    -webkit-hyphenate-limit-before: 3; -webkit-hyphenate-limit-after: 2;
}` : ''}
${s.indent ? `${tuned} p:not([data-ink-keep]):not([data-ink-flush]) { text-indent: 2em !important; }
${tuned} p[data-ink-flush] { text-indent: 0 !important; }` : ''}
${dark ? `
body * { color: inherit !important; background-color: transparent !important; border-color: currentColor !important; }
img, svg image { filter: brightness(.86); }
` : ''}
a:any-link { color: ${accent} !important; text-decoration-color: color-mix(in srgb, ${accent} 40%, transparent); }
::selection { background: color-mix(in srgb, ${accent} 26%, transparent); }
img, svg { max-width: 100%; }
pre { white-space: pre-wrap !important; }
rt { font-size: .5em; }
aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="rearnote"] { display: none; }
`
}

// Mark blocks whose alignment the book set on purpose (centred titles, right-
// aligned signatures…) so justification and indentation skip them, and
// paragraphs that already indent themselves with full-width spaces.
export const tuneDocument = doc => {
    const root = doc.documentElement
    const win = doc.defaultView
    if (!root || !win || !doc.body) return
    root.setAttribute('data-ink-measuring', '')
    const blocks = doc.body.querySelectorAll('p, li, blockquote, dd')
    const limit = Math.min(blocks.length, 6000)
    for (let i = 0; i < limit; i++) {
        const el = blocks[i]
        const align = win.getComputedStyle(el).textAlign
        if (align === 'center' || align === 'right' || align === 'end' || align === '-webkit-center' || align === '-webkit-right')
            el.setAttribute('data-ink-keep', '')
        else if (el.tagName === 'P' || el.tagName === 'p') {
            const text = el.textContent
            if (/^[\u3000\u00a0\u2002\u2003 \t]{2,}/.test(text) || text.startsWith('\u3000')) el.setAttribute('data-ink-flush', '')
            else if (!text.trim()) el.setAttribute('data-ink-keep', '')
        }
    }
    root.removeAttribute('data-ink-measuring')
}

export const writingModeOf = doc => {
    try {
        return doc.defaultView.getComputedStyle(doc.body).writingMode
    } catch {
        return 'horizontal-tb'
    }
}
