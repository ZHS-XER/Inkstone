const svg = (body, extra = '') =>
    `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`

export const icons = {
    back: svg('<path d="M12 4.5 6.5 10l5.5 5.5"/>'),
    forward: svg('<path d="M8 4.5 13.5 10 8 15.5"/>'),
    library: svg('<path d="M4 3.5v13M7.5 3.5v13M11 4l4.5 12"/>'),
    toc: svg('<path d="M7 5.5h9.5M7 10h9.5M7 14.5h9.5"/><path d="M3.5 5.5h.01M3.5 10h.01M3.5 14.5h.01" stroke-width="2"/>'),
    search: svg('<circle cx="8.75" cy="8.75" r="5.25"/><path d="m12.75 12.75 3.75 3.75"/>'),
    bookmark: svg('<path d="M5.5 3.5h9v13.5L10 13.5 5.5 17z"/>'),
    bookmarkFill: svg('<path d="M5.5 3.5h9v13.5L10 13.5 5.5 17z" fill="currentColor"/>'),
    type: svg('<path d="M2.5 15.5 6.75 5h.5L11.5 15.5M4 12h6M13 15.5l2.6-6.5h.3l2.6 6.5M13.9 13.4h3.7"/>'),
    notes: svg('<path d="M4 16.5l.6-3.2 8.6-8.6a1.5 1.5 0 0 1 2.1 0l.5.5a1.5 1.5 0 0 1 0 2.1l-8.6 8.6z"/><path d="M11.8 6.1l2.6 2.6"/>'),
    plus: svg('<path d="M10 4v12M4 10h12"/>'),
    close: svg('<path d="m5 5 10 10M15 5 5 15"/>'),
    trash: svg('<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.7 10h7.6l.7-10M8.5 9v4.5M11.5 9v4.5"/>'),
    copy: svg('<rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M4 13V5.5A1.5 1.5 0 0 1 5.5 4H13"/>'),
    sort: svg('<path d="M4 6h12M6 10h8M8.5 14h3"/>'),
    check: svg('<path d="m4.5 10.5 3.5 3.5 7.5-8"/>'),
    undo: svg('<path d="M7 5 3.5 8.5 7 12"/><path d="M3.5 8.5H12a4 4 0 0 1 0 8h-2"/>'),
    underline: svg('<path d="M6 4v5a4 4 0 0 0 8 0V4M5 16.5h10"/>'),
    exportIcon: svg('<path d="M10 12.5v-9M6.5 7 10 3.5 13.5 7M4 12.5v3A1.5 1.5 0 0 0 5.500 17h9a1.500 1.500 0 0 0 1.500-1.500v-3"/>'),
    dict: svg('<path d="M5 3.500h9.500a1 1 0 0 1 1 1V16.500H6a1.500 1.500 0 0 1 0-3h9.500"/><path d="M4.500 15V5A1.500 1.500 0 0 1 6 3.500"/><path d="M8 10.500l2-5 2 5M8.700 9h2.600"/>'),
    chevron: svg('<path d="m7.500 5 5 5-5 5"/>'),
    stack: svg('<rect x="4" y="6.500" width="12" height="10" rx="1.500"/><path d="M6 4h8"/>'),
}
