import Foundation

/// Read access to the files inside one EPUB, whatever form it takes on disk.
/// Apple Books keeps its library as unpacked folders; everything else is a zip.
public protocol BookContainer: AnyObject {
    /// Every file in the book: path relative to the EPUB root → size in bytes.
    func entrySizes() throws -> [String: Int]
    func data(for path: String) throws -> Data?
}

public enum BookContainers {
    public static func open(_ url: URL) throws -> BookContainer {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw CocoaError(.fileNoSuchFile)
        }
        return isDirectory.boolValue ? DirectoryContainer(root: url) : try ZipContainer(url: url)
    }
}

public final class DirectoryContainer: BookContainer {
    private let root: URL

    public init(root: URL) {
        self.root = root.standardizedFileURL
    }

    public func entrySizes() throws -> [String: Int] {
        var result: [String: Int] = [:]
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return result }
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        for case let url as URL in walker {
            let values = try? url.resourceValues(forKeys: Set(keys))
            guard values?.isRegularFile == true else { continue }
            let path = url.standardizedFileURL.path
            guard path.hasPrefix(prefix) else { continue }
            let relative = String(path.dropFirst(prefix.count))
            result[relative] = values?.fileSize ?? 0
        }
        return result
    }

    public func data(for path: String) throws -> Data? {
        let url = root.appendingPathComponent(path).standardizedFileURL
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        // never serve anything outside the book
        guard url.path.hasPrefix(prefix) else { return nil }
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url, options: .mappedIfSafe)
    }
}

public final class ZipContainer: BookContainer {
    private let archive: ZipArchive
    private let lock = NSLock()

    public init(url: URL) throws {
        archive = try ZipArchive(url: url)
    }

    public func entrySizes() throws -> [String: Int] {
        archive.entries.mapValues { $0.uncompressedSize }
    }

    public func data(for path: String) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return try archive.data(for: path)
    }
}
