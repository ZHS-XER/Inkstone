import Foundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

public struct LibraryBook {
    public enum Source: String { case apple, local }

    public let id: String
    public let url: URL
    public let source: Source
    public let fileName: String
    public let added: Date
    public var meta: EPUBMetadata
}

/// The user's shelf: books imported into Inkstone plus (on the Mac) whatever
/// already lives in Apple Books, which is only ever read, never modified.
public final class Library {
    public struct Folders {
        public var support: URL       // settings, reading state
        public var books: URL         // imported EPUBs
        public var caches: URL        // cover thumbnails
        public var external: [URL]    // read-only shelves (Apple Books)

        public static func standard() -> Folders {
            let fm = FileManager.default
            let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Inkstone", isDirectory: true)
            let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Inkstone", isDirectory: true)
            var external: [URL] = []
            #if os(macOS)
            let home = fm.homeDirectoryForCurrentUser
            external = [
                home.appendingPathComponent("Library/Mobile Documents/iCloud~com~apple~iBooks/Documents", isDirectory: true),
                home.appendingPathComponent("Library/Containers/com.apple.BKAgentService/Data/Documents/iBooks/Books", isDirectory: true),
            ]
            #endif
            return Folders(support: support,
                           books: support.appendingPathComponent("Books", isDirectory: true),
                           caches: caches, external: external)
        }
    }

    public let folders: Folders
    private let fm = FileManager.default
    private let lock = NSLock()
    private var books: [String: LibraryBook] = [:]
    private var containers: [String: BookContainer] = [:]
    private var metaCache: [String: (stamp: Date, meta: EPUBMetadata)] = [:]

    public init(folders: Folders = .standard()) {
        self.folders = folders
        for dir in [folders.support, folders.books, folders.caches, stateFolder, coverFolder] {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    private var stateFolder: URL { folders.support.appendingPathComponent("state", isDirectory: true) }
    private var coverFolder: URL { folders.caches.appendingPathComponent("covers", isDirectory: true) }
    private var settingsFile: URL { folders.support.appendingPathComponent("settings.json") }

    public static func identifier(source: LibraryBook.Source, name: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data("\(source.rawValue):\(name)".utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Scanning

    /// Re-read the shelves from disk. Cheap: metadata is cached per file and
    /// only re-parsed when the file changes.
    @discardableResult
    public func scan() -> [LibraryBook] {
        var found: [String: LibraryBook] = [:]
        let keys: [URLResourceKey] = [.contentModificationDateKey, .creationDateKey, .isDirectoryKey]

        func visit(_ folder: URL, _ source: LibraryBook.Source) {
            guard let items = try? fm.contentsOfDirectory(
                at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
            for url in items where url.pathExtension.lowercased() == "epub" {
                let values = try? url.resourceValues(forKeys: Set(keys))
                let name = url.lastPathComponent
                let id = Library.identifier(source: source, name: name)
                let stamp = values?.contentModificationDate ?? .distantPast
                let fallbackTitle = url.deletingPathExtension().lastPathComponent

                var meta: EPUBMetadata
                lock.lock()
                let cached = metaCache[url.path]
                lock.unlock()
                if let cached, cached.stamp == stamp {
                    meta = cached.meta
                } else {
                    do {
                        meta = try EPUBMetadata.read(from: BookContainers.open(url))
                    } catch {
                        // An unreadable item is skipped rather than shown broken.
                        continue
                    }
                    lock.lock()
                    metaCache[url.path] = (stamp, meta)
                    containers[id] = nil
                    lock.unlock()
                }
                if meta.title.isEmpty { meta.title = fallbackTitle }
                found[id] = LibraryBook(id: id, url: url, source: source, fileName: fallbackTitle,
                                        added: values?.creationDate ?? stamp, meta: meta)
            }
        }

        visit(folders.books, .local)
        for folder in folders.external { visit(folder, .apple) }

        lock.lock()
        books = found
        containers = containers.filter { found[$0.key] != nil }
        lock.unlock()
        return Array(found.values)
    }

    public func book(_ id: String) -> LibraryBook? {
        lock.lock()
        defer { lock.unlock() }
        return books[id]
    }

    public func container(for id: String) throws -> BookContainer? {
        lock.lock()
        if let existing = containers[id] {
            lock.unlock()
            return existing
        }
        let book = books[id]
        lock.unlock()
        guard let book else { return nil }
        let container = try BookContainers.open(book.url)
        lock.lock()
        containers[id] = container
        lock.unlock()
        return container
    }

    /// The shelf as JSON-ready dictionaries, with reading progress merged in.
    public func listing() -> [[String: Any]] {
        scan().map { book in
            let state = self.state(for: book.id)
            let progress = state["progress"] as? [String: Any]
            return [
                "id": book.id,
                "title": book.meta.title,
                "author": book.meta.author,
                "language": book.meta.language,
                "fileName": book.fileName,
                "source": book.source.rawValue,
                "hasCover": book.meta.coverPath != nil,
                "added": book.added.timeIntervalSince1970 * 1000,
                "fraction": progress?["fraction"] ?? NSNull(),
                "lastRead": progress?["updated"] ?? NSNull(),
                "finished": state["finished"] as? Bool ?? false,
            ]
        }
    }

    // MARK: Covers

    /// A JPEG thumbnail of the cover, generated once and cached on disk.
    public func cover(for id: String) -> Data? {
        guard let book = book(id), let path = book.meta.coverPath else { return nil }
        let stamp = Int((try? book.url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate?.timeIntervalSince1970 ?? 0)
        let cached = coverFolder.appendingPathComponent("\(id)-\(stamp).jpg")
        if let data = try? Data(contentsOf: cached) { return data }

        guard let original = try? container(for: id)?.data(for: path) else { return nil }
        guard let thumbnail = Library.thumbnail(from: original, maxPixel: 720) else { return original }
        try? thumbnail.write(to: cached, options: .atomic)
        return thumbnail
    }

    static func thumbnail(from data: Data, maxPixel: Int) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image,
                                   [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }

    // MARK: Importing

    /// Copy EPUBs into the library. Returns the ids of the books now on the shelf.
    @discardableResult
    public func importBooks(_ urls: [URL]) -> [String] {
        var ids: [String] = []
        for url in urls where url.pathExtension.lowercased() == "epub" {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }

            // Already ours (opened from inside the library folder)?
            if url.deletingLastPathComponent().standardizedFileURL == folders.books.standardizedFileURL {
                ids.append(Library.identifier(source: .local, name: url.lastPathComponent))
                continue
            }
            let target = folders.books.appendingPathComponent(url.lastPathComponent)
            do {
                if fm.fileExists(atPath: target.path) {
                    // Same name: treat as an updated copy of the same book.
                    _ = try fm.replaceItemAt(target, withItemAt: try temporaryCopy(of: url))
                } else {
                    try fm.copyItem(at: url, to: target)
                }
                ids.append(Library.identifier(source: .local, name: target.lastPathComponent))
            } catch {
                NSLog("Inkstone: could not import %@: %@", url.path, String(describing: error))
            }
        }
        scan()
        return ids
    }

    private func temporaryCopy(of url: URL) throws -> URL {
        let temp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".epub")
        try fm.copyItem(at: url, to: temp)
        return temp
    }

    /// Remove an imported book (to the Trash where there is one). Books that
    /// belong to Apple Books are never touched.
    public func remove(_ id: String) -> Bool {
        guard let book = book(id), book.source == .local else { return false }
        do {
            #if os(macOS)
            try fm.trashItem(at: book.url, resultingItemURL: nil)
            #else
            try fm.removeItem(at: book.url)
            #endif
        } catch {
            return false
        }
        scan()
        return true
    }

    // MARK: Reading state & settings

    private func stateFile(_ id: String) -> URL {
        let safe = id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        return stateFolder.appendingPathComponent("\(safe).json")
    }

    public func state(for id: String) -> [String: Any] {
        Library.readJSON(stateFile(id))
    }

    public func saveState(_ state: [String: Any], for id: String) {
        Library.writeJSON(state, to: stateFile(id))
    }

    public func settings() -> [String: Any] {
        Library.readJSON(settingsFile)
    }

    public func saveSettings(_ settings: [String: Any]) {
        Library.writeJSON(settings, to: settingsFile)
    }

    static func readJSON(_ url: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }

    static func writeJSON(_ object: [String: Any], to url: URL) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
