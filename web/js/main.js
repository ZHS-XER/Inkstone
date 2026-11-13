import { initSettings } from './settings.js'
import { mountLibrary } from './library.js'
import { mountReader } from './reader.js'
import { call, onHost, platform } from './bridge.js'

const root = document.getElementById('app')
document.documentElement.classList.add(...platform.split(' '))

let unmount = null

const route = () => {
    unmount?.()
    const m = location.hash.match(/^#\/book\/([\w-]+)/)
    if (m) {
        unmount = mountReader(root, m[1], { onClose: () => { location.hash = '#/' } })
    } else {
        call('setTitle', { title: '' }).catch(() => {})
        unmount = mountLibrary(root, { onOpen: id => { location.hash = `#/book/${id}` } })
    }
}

onHost('open-book', ({ id }) => { location.hash = `#/book/${id}` })
onHost('fullscreen', ({ on }) => document.documentElement.classList.toggle('fullscreen', !!on))

// keep the page itself from ever scrolling or zooming
document.addEventListener('gesturestart', e => e.preventDefault())
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => e.preventDefault())

await initSettings()
addEventListener('hashchange', route)
route()
