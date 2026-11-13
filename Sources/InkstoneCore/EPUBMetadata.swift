import Foundation

/// The handful of facts the library shelf needs about a book. The reader
/// itself parses the full package in the web layer.
public struct EPUBMetadata: Codable, Equatable {
    public var title: String = ""
    public var author: String = ""
    public var language: String = ""
    /// Path of the cover image, relative to the EPUB root.
    public var coverPath: String?

    public static func read(from container: BookContainer) throws -> EPUBMetadata {
        guard let containerXML = try container.data(for: "META-INF/container.xml") else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let rootfile = RootfileParser()
        rootfile.parse(containerXML)
        guard let opfPath = rootfile.path, let opf = try container.data(for: opfPath) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let package = PackageParser()
        package.parse(opf)

        var meta = EPUBMetadata()
        meta.title = package.title.trimmingCharacters(in: .whitespacesAndNewlines)
        meta.author = package.creators
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "、")
        meta.language = package.language.trimmingCharacters(in: .whitespacesAndNewlines)

        let cover = package.items.first { $0.properties.split(separator: " ").contains("cover-image") }
            ?? package.items.first { !package.coverID.isEmpty && $0.id == package.coverID && $0.mediaType.hasPrefix("image/") }
            ?? package.items.first { $0.id.lowercased().contains("cover") && $0.mediaType.hasPrefix("image/") }
        if let href = cover?.href {
            meta.coverPath = resolve(href, relativeTo: opfPath)
        }
        return meta
    }

    /// Resolve a manifest href against the directory of the OPF file.
    static func resolve(_ href: String, relativeTo opfPath: String) -> String {
        let decoded = href.removingPercentEncoding ?? href
        var parts = opfPath.split(separator: "/").dropLast().map(String.init)
        for piece in decoded.split(separator: "/") {
            switch piece {
            case ".": continue
            case "..": if !parts.isEmpty { parts.removeLast() }
            default: parts.append(String(piece))
            }
        }
        return parts.joined(separator: "/")
    }
}

private final class RootfileParser: NSObject, XMLParserDelegate {
    var path: String?

    func parse(_ data: Data) {
        let parser = XMLParser(data: data)
        parser.delegate = self
        parser.parse()
    }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                qualifiedName: String?, attributes: [String: String] = [:]) {
        if path == nil, name.hasSuffix("rootfile"), let full = attributes["full-path"] {
            path = full
            parser.abortParsing()
        }
    }
}

private final class PackageParser: NSObject, XMLParserDelegate {
    struct Item {
        var id = "", href = "", mediaType = "", properties = ""
    }

    var title = ""
    var creators: [String] = []
    var language = ""
    var coverID = ""
    var items: [Item] = []

    private var text = ""
    private var capturing = false
    private var sawTitle = false

    func parse(_ data: Data) {
        let parser = XMLParser(data: data)
        parser.delegate = self
        parser.shouldResolveExternalEntities = false
        parser.parse()
    }

    private func local(_ name: String) -> String {
        name.split(separator: ":").last.map(String.init) ?? name
    }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                qualifiedName: String?, attributes: [String: String] = [:]) {
        switch local(name) {
        case "title", "creator", "language":
            capturing = name.hasPrefix("dc:") || !name.contains(":")
            text = ""
        case "meta":
            if attributes["name"] == "cover", let content = attributes["content"] { coverID = content }
        case "item":
            items.append(Item(id: attributes["id"] ?? "", href: attributes["href"] ?? "",
                              mediaType: attributes["media-type"] ?? "",
                              properties: attributes["properties"] ?? ""))
        default:
            break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if capturing { text += string }
    }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?,
                qualifiedName: String?) {
        guard capturing else { return }
        switch local(name) {
        case "title":
            if !sawTitle { title = text; sawTitle = !text.trimmingCharacters(in: .whitespaces).isEmpty }
        case "creator":
            creators.append(text)
        case "language":
            if language.isEmpty { language = text }
        default:
            return
        }
        capturing = false
    }
}
