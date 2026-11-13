import AppKit
import WebKit

/// Development aid, active only when `INKSTONE_DEBUG=<folder>` is set: drop a
/// `cmd.js` file into the folder and its contents are run in the page as the
/// body of an async function; the returned value lands in `result.json` and a
/// snapshot of the web view in `shot.png`. This is how the app is driven and
/// inspected from the command line without any UI-scripting permissions.
@MainActor
final class DebugChannel {
    private let folder: URL
    private weak var webView: WKWebView?
    private weak var window: NSWindow?
    private var timer: Timer?

    init(folder: URL, webView: WKWebView, window: NSWindow) {
        self.folder = folder
        self.webView = webView
        self.window = window
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
    }

    private var busy = false

    private func poll() {
        guard !busy, let webView else { return }
        let command = folder.appendingPathComponent("cmd.js")
        guard let script = try? String(contentsOf: command, encoding: .utf8) else { return }
        try? FileManager.default.removeItem(at: command)
        busy = true
        Task { @MainActor in
            var output: [String: Any] = [:]
            do {
                let value = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
                output["result"] = value ?? NSNull()
            } catch {
                output["error"] = String(describing: error)
            }
            output["window"] = self.windowInfo()
            if let image = try? await webView.takeSnapshot(configuration: nil),
               let tiff = image.tiffRepresentation,
               let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                try? png.write(to: self.folder.appendingPathComponent("shot.png"))
            }
            let safe = JSONSerialization.isValidJSONObject(output) ? output : ["result": String(describing: output)]
            let data = (try? JSONSerialization.data(withJSONObject: safe, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            try? data.write(to: self.folder.appendingPathComponent("result.json"), options: .atomic)
            self.busy = false
        }
    }

    /// Facts about the native window that can't be seen from inside the page.
    private func windowInfo() -> [String: Any] {
        guard let window, let content = window.contentView else { return [:] }
        var info: [String: Any] = [
            "frame": NSStringFromRect(window.frame),
            "contentLayoutRect": NSStringFromRect(window.contentLayoutRect),
            "fullScreen": window.styleMask.contains(.fullScreen),
            "title": window.title,
            "windowNumber": window.windowNumber,
            "visible": window.isVisible,
            "occluded": !window.occlusionState.contains(.visible),
            "miniaturized": window.isMiniaturized,
            "screen": window.screen.map { NSStringFromRect($0.frame) } ?? "none",
            "active": NSApp.isActive,
        ]
        if let close = window.standardWindowButton(.closeButton), let zoom = window.standardWindowButton(.zoomButton),
           let host = close.superview {
            info["closeButton"] = NSStringFromRect(host.convert(close.frame, to: nil))
            info["zoomButton"] = NSStringFromRect(host.convert(zoom.frame, to: nil))
        }
        // which view would receive a click in the middle of the title strip?
        if let frameView = content.superview {
            let point = NSPoint(x: content.bounds.midX, y: content.bounds.height - 20)
            let hit = frameView.hitTest(frameView.convert(point, from: nil))
            info["titleStripHit"] = hit.map { String(describing: type(of: $0)) } ?? "nil"
        }
        return info
    }
}
