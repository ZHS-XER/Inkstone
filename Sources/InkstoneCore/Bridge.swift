import Foundation
import WebKit
import CoreText

/// What the web UI may ask the surrounding app to do. Each platform shell
/// implements this; everything else about the bridge is shared.
@MainActor
public protocol BridgeHost: AnyObject {
    /// Present a file picker and return the chosen EPUBs.
    func pickBooks() async -> [URL]
    /// Save `text` to a file of the user's choosing. Returns false if cancelled.
    func exportText(_ text: String, suggestedName: String) async -> Bool
    func openExternal(_ url: URL)
    func reveal(_ url: URL)
    func setTitle(_ title: String)
    func setAppearance(dark: Bool)
    func dragWindow()
    func zoomWindow()
    /// Show or hide window furniture that sits over the page (traffic lights).
    func setChrome(visible: Bool)
    /// Look a word up in the system dictionary.
    func lookUp(_ text: String)
}

/// Serves the web UI and the books to the web view over the `inkstone://`
/// scheme, and answers its method calls. Mirrors `dev/server.mjs`.
public final class Bridge: NSObject, WKURLSchemeHandler, WKScriptMessageHandlerWithReply {
    public static let scheme = "inkstone"
    public static let startURL = URL(string: "inkstone://app/index.html")!

    public let library: Library
    public let webRoot: URL
    public weak var host: BridgeHost?
    public weak var webView: WKWebView?

    /// A typeface shipped inside the app. Web content can't see fonts an app
    /// registers for itself, so these are served to the page as web fonts.
    public struct BundledFont {
        public let family: String
        public let file: String
        /// CSS `font-weight` descriptor: a single weight, or a range for variable fonts.
        public let weight: String

        public init(family: String, file: String, weight: String = "400") {
            self.family = family
            self.file = file
            self.weight = weight
        }
    }

    /// Folder the bundled fonts live in, and which of them are present.
    public var fontsRoot: URL?
    public var bundledFonts: [BundledFont] = []

    private let queue = DispatchQueue(label: "inkstone.bridge", qos: .userInitiated, attributes: .concurrent)
    private var liveTasks = Set<ObjectIdentifier>()   // main thread only

    public init(library: Library, webRoot: URL) {
        self.library = library
        self.webRoot = webRoot.standardizedFileURL
    }

    /// A web view configuration wired to this bridge.
    @MainActor
    public func makeConfiguration(platform: String) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(self, forURLScheme: Bridge.scheme)
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "inkstone")
        let fonts = bundledFonts.map { ["family": $0.family, "file": $0.file, "weight": $0.weight] }
        let fontsJSON = (try? JSONSerialization.data(withJSONObject: fonts))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__inkstonePlatform = '\(platform)'; window.__inkstoneFonts = \(fontsJSON);",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        return configuration
    }

    /// Notify the web UI of something that happened on the native side.
    @MainActor
    public func emit(_ event: String, _ detail: [String: Any] = [:]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__inkstone?.emit('\(event)', \(json))", completionHandler: nil)
    }

    // MARK: Resources

    struct Response {
        var status = 200
        var mime = "application/octet-stream"
        var data = Data()
        /// Never changes for the life of the app, so the web view may keep it.
        var immutable = false

        static let notFound = Response(status: 404, mime: "text/plain", data: Data("not found".utf8))
    }

    func respond(to url: URL) -> Response {
        // url.path is already percent-decoded
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)

        if parts.first == "api" {
            if parts.count == 2, parts[1] == "library" {
                return json(["books": library.listing()])
            }
            if parts.count == 3, parts[1] == "entries" {
                guard let sizes = try? library.container(for: parts[2])?.entrySizes() else { return .notFound }
                return json(sizes)
            }
            return .notFound
        }
        if parts.first == "cover", parts.count == 2 {
            guard let data = library.cover(for: parts[1]) else { return .notFound }
            return Response(mime: MIME.sniffImage(data) ?? "image/jpeg", data: data)
        }
        if parts.first == "book", parts.count >= 3 {
            let path = parts.dropFirst(2).joined(separator: "/")
            guard let data = try? library.container(for: parts[1])?.data(for: path) else { return .notFound }
            return Response(mime: MIME.type(forPath: path), data: data)
        }

        if parts.first == "fonts", parts.count == 2, let fontsRoot,
           bundledFonts.contains(where: { $0.file == parts[1] }) {
            let file = fontsRoot.appendingPathComponent(parts[1])
            guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return .notFound }
            return Response(mime: MIME.type(forPath: parts[1]), data: data, immutable: true)
        }

        // the web UI itself
        let relative = parts.isEmpty ? "index.html" : parts.joined(separator: "/")
        let file = webRoot.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(webRoot.path + "/"),
              let data = try? Data(contentsOf: file) else { return .notFound }
        return Response(mime: MIME.type(forPath: relative), data: data)
    }

    private func json(_ object: Any) -> Response {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return Response(mime: "application/json; charset=utf-8", data: data)
    }

    public func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let key = ObjectIdentifier(task)
        liveTasks.insert(key)
        queue.async { [weak self] in
            guard let self else { return }
            let response = self.respond(to: url)
            DispatchQueue.main.async {
                // WebKit raises an exception if a stopped task is touched.
                guard self.liveTasks.remove(key) != nil else { return }
                let headers = [
                    "Content-Type": response.mime,
                    "Content-Length": String(response.data.count),
                    "Cache-Control": response.immutable ? "public, max-age=31536000, immutable" : "no-store",
                    "Access-Control-Allow-Origin": "*",
                ]
                guard let http = HTTPURLResponse(url: url, statusCode: response.status,
                                                 httpVersion: "HTTP/1.1", headerFields: headers) else {
                    task.didFailWithError(URLError(.unknown))
                    return
                }
                task.didReceive(http)
                task.didReceive(response.data)
                task.didFinish()
            }
        }
    }

    public func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        liveTasks.remove(ObjectIdentifier(task))
    }

    // MARK: Calls

    public func userContentController(_ controller: WKUserContentController,
                                      didReceive message: WKScriptMessage,
                                      replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "malformed call")
            return
        }
        let params = body["params"] as? [String: Any] ?? [:]
        Task { @MainActor in
            replyHandler(await self.call(method, params), nil)
        }
    }

    @MainActor
    func call(_ method: String, _ params: [String: Any]) async -> Any? {
        let id = params["id"] as? String ?? ""
        switch method {
        case "getState":
            return library.state(for: id)
        case "saveState":
            guard !id.isEmpty, let state = params["state"] as? [String: Any] else { return false }
            library.saveState(state, for: id)
            return true
        case "getSettings":
            return library.settings()
        case "saveSettings":
            guard let settings = params["settings"] as? [String: Any] else { return false }
            library.saveSettings(settings)
            return true
        case "importBooks":
            let urls = await host?.pickBooks() ?? []
            let ids = library.importBooks(urls)
            return ["imported": ids.count, "ids": ids]
        case "removeBook":
            return library.remove(id)
        case "refreshLibrary":
            library.scan()
            return true
        case "exportText":
            guard let text = params["text"] as? String else { return false }
            return await host?.exportText(text, suggestedName: params["name"] as? String ?? "笔记.md") ?? false
        case "openExternal":
            if let string = params["url"] as? String, let url = URL(string: string),
               ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                host?.openExternal(url)
            }
            return true
        case "revealBook":
            if let book = library.book(id) { host?.reveal(book.url) }
            return true
        case "setTitle":
            host?.setTitle(params["title"] as? String ?? "")
            return true
        case "setAppearance":
            host?.setAppearance(dark: params["dark"] as? Bool ?? false)
            return true
        case "dragWindow":
            host?.dragWindow()
            return true
        case "zoomWindow":
            host?.zoomWindow()
            return true
        case "setChrome":
            host?.setChrome(visible: params["visible"] as? Bool ?? true)
            return true
        case "lookUp":
            if let text = params["text"] as? String, !text.isEmpty { host?.lookUp(text) }
            return true
        case "listFonts":
            return Fonts.cjkFamilies()
        default:
            return NSNull()
        }
    }
}

enum MIME {
    static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8",
        "xhtml": "application/xhtml+xml", "xml": "application/xml",
        "opf": "application/oebps-package+xml", "ncx": "application/x-dtbncx+xml",
        "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json; charset=utf-8",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "avif": "image/avif", "bmp": "image/bmp",
        "ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2",
        "mp3": "audio/mpeg", "m4a": "audio/mp4", "mp4": "video/mp4",
        "txt": "text/plain; charset=utf-8", "smil": "application/smil+xml",
    ]

    static func type(forPath path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        return types[ext] ?? "application/octet-stream"
    }

    static func sniffImage(_ data: Data) -> String? {
        guard data.count >= 12 else { return nil }
        let b = [UInt8](data.prefix(12))
        if b[0] == 0xff, b[1] == 0xd8 { return "image/jpeg" }
        if b[0] == 0x89, b[1] == 0x50 { return "image/png" }
        if b[0] == 0x47, b[1] == 0x49 { return "image/gif" }
        if b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 { return "image/webp" }
        return nil
    }
}

enum Fonts {
    /// Installed font families that can set Chinese or Japanese text, for the
    /// reader's "more fonts" menu.
    static func cjkFamilies() -> [String] {
        let wanted: Set<String> = ["zh-Hans", "zh-Hant", "ja", "zh"]
        let families = CTFontManagerCopyAvailableFontFamilyNames() as? [String] ?? []
        var result: [String] = []
        for family in families where !family.hasPrefix(".") {
            let descriptor = CTFontDescriptorCreateWithAttributes(
                [kCTFontFamilyNameAttribute: family] as CFDictionary)
            guard let languages = CTFontDescriptorCopyAttribute(descriptor, kCTFontLanguagesAttribute) as? [String],
                  !wanted.isDisjoint(with: languages) else { continue }
            result.append(family)
        }
        return result.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}
