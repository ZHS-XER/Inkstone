import Foundation
import WebKit
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// Development aid, active only when `INKSTONE_DEBUG=<folder>` is set: drop a
/// `cmd.js` file into the folder and its contents are run in the page as the
/// body of an async function; the returned value lands in `result.json` and a
/// snapshot of the web view in `shot.png`. This is how the app is driven and
/// inspected from the command line without any UI-scripting permissions —
/// on the Mac, and in the iOS simulator (which shares the host's file system).
@MainActor
public final class DebugChannel {
    private let folder: URL
    private weak var webView: WKWebView?
    private let info: () -> [String: Any]
    private var timer: Timer?
    private var busy = false

    /// `info` supplies native facts the page can't see (window geometry…).
    public init(folder: URL, webView: WKWebView, info: @escaping () -> [String: Any] = { [:] }) {
        self.folder = folder
        self.webView = webView
        self.info = info
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
    }

    /// The channel for this process, if the environment asks for one.
    public static func fromEnvironment(webView: WKWebView,
                                       info: @escaping () -> [String: Any] = { [:] }) -> DebugChannel? {
        guard let path = ProcessInfo.processInfo.environment["INKSTONE_DEBUG"], !path.isEmpty else { return nil }
        return DebugChannel(folder: URL(fileURLWithPath: path, isDirectory: true), webView: webView, info: info)
    }

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
            output["window"] = self.info()
            if let image = try? await webView.takeSnapshot(configuration: nil), let png = DebugChannel.png(image) {
                try? png.write(to: self.folder.appendingPathComponent("shot.png"))
            }
            let safe = JSONSerialization.isValidJSONObject(output) ? output : ["result": String(describing: output)]
            let data = (try? JSONSerialization.data(withJSONObject: safe, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            try? data.write(to: self.folder.appendingPathComponent("result.json"), options: .atomic)
            self.busy = false
        }
    }

    #if canImport(AppKit)
    private static func png(_ image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation else { return nil }
        return NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
    }
    #elseif canImport(UIKit)
    private static func png(_ image: UIImage) -> Data? { image.pngData() }
    #endif
}
