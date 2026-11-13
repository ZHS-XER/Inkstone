import AppKit
import WebKit
import UniformTypeIdentifiers
import InkstoneCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, BridgeHost {
    private var window: ReaderWindow!
    private var webView: BookWebView!
    private var bridge: Bridge!
    private var debug: DebugChannel?
    private var pendingOpen: [URL] = []
    private var ready = false

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `INKSTONE_HOME=<folder>` runs against a self-contained library in that
        // folder (no Apple Books, nothing shared with the real one) — for demos
        // and for testing without touching the user's reading state.
        let library: Library
        if let home = ProcessInfo.processInfo.environment["INKSTONE_HOME"] {
            let root = URL(fileURLWithPath: home, isDirectory: true)
            library = Library(folders: .init(support: root,
                                             books: root.appendingPathComponent("Books", isDirectory: true),
                                             caches: root.appendingPathComponent("Caches", isDirectory: true),
                                             external: []))
        } else {
            library = Library()
        }
        bridge = Bridge(library: library, webRoot: AppDelegate.locateWebRoot())
        bridge.host = self

        let configuration = bridge.makeConfiguration(platform: "mac")
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = BookWebView(frame: .zero, configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.onDropBooks = { [weak self] urls in self?.importAndOpen(urls) }
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        bridge.webView = webView

        window = ReaderWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "Inkstone"
        window.minSize = NSSize(width: 420, height: 480)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.delegate = self
        window.contentView = webView
        window.webView = webView
        // An empty unified toolbar gives the title bar the same height as our
        // own top bar, which centres the traffic lights in it.
        let toolbar = NSToolbar(identifier: "main")
        toolbar.showsBaselineSeparator = false
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.center()
        if ProcessInfo.processInfo.environment["INKSTONE_HOME"] == nil {
            window.setFrameAutosaveName("InkstoneMain")
        }
        setAppearance(dark: NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)

        NSApp.mainMenu = MainMenu.build(target: self)
        webView.load(URLRequest(url: Bridge.startURL))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let folder = ProcessInfo.processInfo.environment["INKSTONE_DEBUG"] {
            debug = DebugChannel(folder: URL(fileURLWithPath: folder), webView: webView, window: window)
        }

        ready = true
        if !pendingOpen.isEmpty {
            let urls = pendingOpen
            pendingOpen = []
            // give the page a moment to boot before asking it to open a book
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.importAndOpen(urls) }
        }
    }

    /// The web UI ships inside the app bundle; when run straight from the
    /// build folder (`swift run`) it is found in the source tree instead.
    static func locateWebRoot() -> URL {
        if let override = ProcessInfo.processInfo.environment["INKSTONE_WEB"] {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
           FileManager.default.fileExists(atPath: bundled.appendingPathComponent("index.html").path) {
            return bundled
        }
        var dir = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("web", isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("index.html").path) {
                return candidate
            }
            dir.deleteLastPathComponent()
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("web")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationDidBecomeActive(_ notification: Notification) {
        // Books may have been added to Apple Books while we were away.
        if ready { bridge.emit("library-changed") }
    }

    // MARK: Opening files

    func application(_ application: NSApplication, open urls: [URL]) {
        if ready { importAndOpen(urls) } else { pendingOpen += urls }
    }

    private func importAndOpen(_ urls: [URL]) {
        let ids = bridge.library.importBooks(urls)
        bridge.emit("library-changed")
        if let last = ids.last { bridge.emit("open-book", ["id": last]) }
        window.makeKeyAndOrderFront(nil)
    }

    @objc func importFromMenu(_ sender: Any?) {
        Task {
            let urls = await pickBooks()
            if !urls.isEmpty { importAndOpen(urls) }
        }
    }

    @objc func reloadPage(_ sender: Any?) {
        webView.reload()
    }

    // MARK: Window

    func windowDidEnterFullScreen(_ notification: Notification) { bridge.emit("fullscreen", ["on": true]) }
    func windowDidExitFullScreen(_ notification: Notification) { bridge.emit("fullscreen", ["on": false]) }

    // MARK: BridgeHost

    func pickBooks() async -> [URL] {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [UTType(filenameExtension: "epub") ?? .data]
        panel.prompt = "导入"
        panel.message = "选择要加入书库的 EPUB"
        let response = await panel.beginSheetModal(for: window)
        return response == .OK ? panel.urls : []
    }

    func exportText(_ text: String, suggestedName: String) async -> Bool {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName.replacingOccurrences(of: "/", with: "-")
        panel.canCreateDirectories = true
        guard await panel.beginSheetModal(for: window) == .OK, let url = panel.url else { return false }
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            return true
        } catch {
            NSAlert(error: error).runModal()
            return false
        }
    }

    func openExternal(_ url: URL) { NSWorkspace.shared.open(url) }
    func reveal(_ url: URL) { NSWorkspace.shared.activateFileViewerSelecting([url]) }

    func setTitle(_ title: String) {
        window.title = title.isEmpty ? "Inkstone" : title
    }

    func setAppearance(dark: Bool) {
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.backgroundColor = dark
            ? NSColor(srgbRed: 0.165, green: 0.161, blue: 0.149, alpha: 1)
            : NSColor(srgbRed: 0.980, green: 0.976, blue: 0.961, alpha: 1)
    }

    func dragWindow() {
        guard let event = window.lastMouseDown, NSEvent.pressedMouseButtons & 1 == 1 else { return }
        window.performDrag(with: event)
    }

    func zoomWindow() {
        window.zoom(nil)
    }

    func setChrome(visible: Bool) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = visible ? 0.18 : 0.3
            for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
                window.standardWindowButton(kind)?.animator().alphaValue = visible ? 1 : 0
            }
        }
    }

    func lookUp(_ text: String) {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        guard let word = text.addingPercentEncoding(withAllowedCharacters: allowed),
              let url = URL(string: "dict://\(word)") else { return }
        NSWorkspace.shared.open(url)
    }
}

/// The window has no visible title bar: the web UI draws its own top bar under
/// a transparent one and asks for a window drag when a click lands on an empty
/// part of it. Normally AppKit delivers clicks in that strip to the web view by
/// itself; should a title-bar view ever claim one, it is handed to the web view
/// here instead so the page's buttons keep working.
final class ReaderWindow: NSWindow {
    weak var webView: WKWebView?
    private(set) var lastMouseDown: NSEvent?
    private var routing = false

    private func titleBarWouldSwallow(_ event: NSEvent) -> Bool {
        guard let webView, let content = contentView, let frameView = content.superview,
              !styleMask.contains(.fullScreen) else { return false }
        let p = event.locationInWindow
        let stripHeight = content.bounds.height - contentLayoutRect.height
        guard stripHeight > 0, p.y >= content.bounds.height - stripHeight else { return false }
        // leave the traffic lights alone
        if let zoom = standardWindowButton(.zoomButton), let host = zoom.superview {
            let frame = host.convert(zoom.frame, to: nil)
            if p.x <= frame.maxX + 8 { return false }
        }
        guard let hit = frameView.hitTest(frameView.convert(p, from: nil)) else { return true }
        return !(hit === webView || hit.isDescendant(of: webView))
    }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            lastMouseDown = event
            if let webView, titleBarWouldSwallow(event) {
                routing = true
                if !isKeyWindow { makeKeyAndOrderFront(nil) }
                makeFirstResponder(webView)
                webView.mouseDown(with: event)
                return
            }
        case .leftMouseDragged:
            if routing, let webView { webView.mouseDragged(with: event); return }
        case .leftMouseUp:
            if routing, let webView {
                routing = false
                webView.mouseUp(with: event)
                return
            }
        default:
            break
        }
        super.sendEvent(event)
    }
}

/// A web view that accepts EPUB files dropped onto it.
final class BookWebView: WKWebView {
    var onDropBooks: (([URL]) -> Void)?

    private func books(in sender: NSDraggingInfo) -> [URL] {
        let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.filter { $0.pathExtension.lowercased() == "epub" }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        books(in: sender).isEmpty ? [] : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        books(in: sender).isEmpty ? [] : .copy
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        !books(in: sender).isEmpty
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = books(in: sender)
        guard !urls.isEmpty else { return false }
        onDropBooks?(urls)
        return true
    }

    // the page supplies its own context menus
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.items.removeAll { item in
            guard let id = item.identifier?.rawValue else { return false }
            return id.contains("Reload") || id.contains("GoBack") || id.contains("GoForward")
        }
    }
}
