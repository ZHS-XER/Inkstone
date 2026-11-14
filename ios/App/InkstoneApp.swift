import SwiftUI
import WebKit
import UIKit
import UniformTypeIdentifiers
import InkstoneCore

@main
struct InkstoneApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            WebContainer(model: model)
                .ignoresSafeArea()
                .background(model.dark ? Color(red: 0.165, green: 0.161, blue: 0.149)
                                       : Color(red: 0.980, green: 0.976, blue: 0.961))
                .statusBarHidden(!model.chromeVisible)
                .preferredColorScheme(model.dark ? .dark : .light)
                .persistentSystemOverlays(model.chromeVisible ? .automatic : .hidden)
                .onOpenURL { model.open([$0]) }
        }
    }
}

/// Owns the library, the bridge and the web view, and answers the web UI's
/// requests for things only the system can do.
@MainActor
final class AppModel: NSObject, ObservableObject, BridgeHost, UIDocumentPickerDelegate {
    @Published var dark = false
    @Published var chromeVisible = true

    let bridge: Bridge
    let webView: WKWebView
    private var pickContinuation: CheckedContinuation<[URL], Never>?
    private var debug: DebugChannel?
    private var loaded = false
    private var pendingOpen: [URL] = []

    override init() {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Inkstone", isDirectory: true)
        let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Inkstone", isDirectory: true)
        // Imported books sit in Documents so they show up in the Files app,
        // where more can be dropped in.
        let documents = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let library = Library(folders: .init(support: support, books: documents, caches: caches, external: []))

        let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        bridge = Bridge(library: library, webRoot: webRoot)
        // iOS has no Chinese serif or kai face of its own; see scripts/fetch-ios-fonts.sh
        let fontsRoot = Bundle.main.resourceURL!.appendingPathComponent("Fonts", isDirectory: true)
        bridge.fontsRoot = fontsRoot
        bridge.bundledFonts = [
            Bridge.BundledFont(family: "Noto Serif SC", file: "NotoSerifSC.ttf", weight: "200 900"),
            Bridge.BundledFont(family: "LXGW WenKai", file: "LXGWWenKai-Regular.ttf"),
        ].filter { fm.fileExists(atPath: fontsRoot.appendingPathComponent($0.file).path) }

        let platform = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
        let configuration = bridge.makeConfiguration(platform: "ios \(platform)")
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        super.init()
        bridge.host = self
        bridge.webView = webView
        debug = DebugChannel.fromEnvironment(webView: webView)
        webView.load(URLRequest(url: Bridge.startURL))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            self.loaded = true
            if !self.pendingOpen.isEmpty {
                let urls = self.pendingOpen
                self.pendingOpen = []
                self.open(urls)
            }
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.bridge.emit("library-changed") }
        }
    }

    /// Import EPUBs handed to the app ("Open in Inkstone") and open the last one.
    func open(_ urls: [URL]) {
        guard loaded else {
            pendingOpen += urls
            return
        }
        let ids = bridge.library.importBooks(urls)
        bridge.emit("library-changed")
        if let last = ids.last { bridge.emit("open-book", ["id": last]) }
    }

    private var presenter: UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    // MARK: BridgeHost

    func pickBooks() async -> [URL] {
        guard let presenter else { return [] }
        let type = UTType(filenameExtension: "epub") ?? .data
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [type], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        return await withCheckedContinuation { continuation in
            pickContinuation?.resume(returning: [])
            pickContinuation = continuation
            presenter.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pickContinuation?.resume(returning: urls)
        pickContinuation = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickContinuation?.resume(returning: [])
        pickContinuation = nil
    }

    func exportText(_ text: String, suggestedName: String) async -> Bool {
        guard let presenter else { return false }
        let name = suggestedName.replacingOccurrences(of: "/", with: "-")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try text.write(to: file, atomically: true, encoding: .utf8)
        } catch {
            return false
        }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = webView
        sheet.popoverPresentationController?.sourceRect = CGRect(x: webView.bounds.midX, y: 60, width: 1, height: 1)
        return await withCheckedContinuation { continuation in
            sheet.completionWithItemsHandler = { _, completed, _, _ in continuation.resume(returning: completed) }
            presenter.present(sheet, animated: true)
        }
    }

    func openExternal(_ url: URL) { UIApplication.shared.open(url) }
    func reveal(_ url: URL) {}
    func setTitle(_ title: String) {}
    func dragWindow() {}
    func zoomWindow() {}

    func setAppearance(dark: Bool) {
        if self.dark != dark { self.dark = dark }
    }

    func setChrome(visible: Bool) {
        if chromeVisible != visible {
            withAnimation(.easeInOut(duration: 0.2)) { chromeVisible = visible }
        }
    }

    func lookUp(_ text: String) {
        guard let presenter else { return }
        presenter.present(UIReferenceLibraryViewController(term: text), animated: true)
    }
}

struct WebContainer: UIViewRepresentable {
    let model: AppModel

    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
