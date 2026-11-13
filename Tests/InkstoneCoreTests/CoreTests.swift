import XCTest
@testable import InkstoneCore

final class CoreTests: XCTestCase {
    private var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("inkstone-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    /// Lay out a tiny EPUB as a folder, the way Apple Books stores them.
    private func makeBookFolder(named name: String = "Sample.epub", title: String = "示例之书") throws -> URL {
        let root = temp.appendingPathComponent(name)
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("META-INF"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("OEBPS/Images"), withIntermediateDirectories: true)
        try "application/epub+zip".write(to: root.appendingPathComponent("mimetype"), atomically: true, encoding: .utf8)
        try """
        <?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
        </container>
        """.write(to: root.appendingPathComponent("META-INF/container.xml"), atomically: true, encoding: .utf8)
        try """
        <?xml version="1.0" encoding="utf-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:identifier id="id">urn:uuid:1234</dc:identifier>
            <dc:title>\(title)</dc:title>
            <dc:creator>某作者</dc:creator>
            <dc:creator>某译者</dc:creator>
            <dc:language>zh</dc:language>
            <meta name="cover" content="cover-img"/>
          </metadata>
          <manifest>
            <item id="ch1" href="Text/ch%201.xhtml" media-type="application/xhtml+xml"/>
            <item id="cover-img" href="Images/cover.png" media-type="image/png"/>
          </manifest>
          <spine><itemref idref="ch1"/></spine>
        </package>
        """.write(to: root.appendingPathComponent("OEBPS/content.opf"), atomically: true, encoding: .utf8)
        try Data([0x89, 0x50, 0x4e, 0x47]).write(to: root.appendingPathComponent("OEBPS/Images/cover.png"))
        return root
    }

    private func zip(_ folder: URL, to archive: URL) throws {
        // mimetype stored first and uncompressed, the rest deflated — a real EPUB
        for args in [["-X0q", archive.path, "mimetype"], ["-Xr9Dq", archive.path, ".", "-x", "mimetype"]] {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
            process.arguments = args
            process.currentDirectoryURL = folder
            try process.run()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0)
        }
    }

    func testMetadataFromFolder() throws {
        let container = try BookContainers.open(try makeBookFolder())
        let meta = try EPUBMetadata.read(from: container)
        XCTAssertEqual(meta.title, "示例之书")
        XCTAssertEqual(meta.author, "某作者、某译者")
        XCTAssertEqual(meta.language, "zh")
        XCTAssertEqual(meta.coverPath, "OEBPS/Images/cover.png")
    }

    func testZipMatchesFolder() throws {
        let folder = try makeBookFolder()
        // something compressible, so the deflate path is really exercised
        let text = String(repeating: "天地玄黄，宇宙洪荒。", count: 4000)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("OEBPS/Text"), withIntermediateDirectories: true)
        try text.write(to: folder.appendingPathComponent("OEBPS/Text/ch 1.xhtml"), atomically: true, encoding: .utf8)

        let archive = temp.appendingPathComponent("Zipped.epub")
        try zip(folder, to: archive)

        let fromFolder = try BookContainers.open(folder)
        let fromZip = try BookContainers.open(archive)
        XCTAssertTrue(fromZip is ZipContainer)
        XCTAssertEqual(try fromZip.entrySizes(), try fromFolder.entrySizes())
        XCTAssertEqual(try fromZip.data(for: "OEBPS/Text/ch 1.xhtml"), Data(text.utf8))
        XCTAssertEqual(try fromZip.data(for: "mimetype"), Data("application/epub+zip".utf8))
        XCTAssertNil(try fromZip.data(for: "nope.txt"))
        XCTAssertEqual(try EPUBMetadata.read(from: fromZip), try EPUBMetadata.read(from: fromFolder))
    }

    func testFolderContainerStaysInsideTheBook() throws {
        let folder = try makeBookFolder()
        try "secret".write(to: temp.appendingPathComponent("outside.txt"), atomically: true, encoding: .utf8)
        let container = try BookContainers.open(folder)
        XCTAssertNil(try container.data(for: "../outside.txt"))
        XCTAssertNotNil(try container.data(for: "mimetype"))
    }

    func testRejectsNonZip() {
        XCTAssertThrowsError(try ZipArchive(data: Data(repeating: 7, count: 400)))
        XCTAssertThrowsError(try ZipArchive(data: Data()))
    }

    func testHrefResolution() {
        XCTAssertEqual(EPUBMetadata.resolve("Images/a%20b.jpg", relativeTo: "OEBPS/content.opf"), "OEBPS/Images/a b.jpg")
        XCTAssertEqual(EPUBMetadata.resolve("../cover.jpg", relativeTo: "OEBPS/content.opf"), "cover.jpg")
        XCTAssertEqual(EPUBMetadata.resolve("cover.jpg", relativeTo: "content.opf"), "cover.jpg")
    }

    func testLibraryImportStateAndRemoval() throws {
        let folders = Library.Folders(
            support: temp.appendingPathComponent("support"),
            books: temp.appendingPathComponent("support/Books"),
            caches: temp.appendingPathComponent("caches"),
            external: [temp.appendingPathComponent("shelf")])
        try FileManager.default.createDirectory(at: folders.external[0], withIntermediateDirectories: true)
        let library = Library(folders: folders)

        // a read-only shelf (stands in for Apple Books) holding an unpacked book
        let shelved = try makeBookFolder(named: "Shelved.epub", title: "架上之书")
        try FileManager.default.moveItem(at: shelved, to: folders.external[0].appendingPathComponent("Shelved.epub"))

        // and a zipped book that gets imported
        let source = try makeBookFolder(named: "Loose.epub", title: "散装之书")
        let archive = temp.appendingPathComponent("Imported.epub")
        try zip(source, to: archive)
        let ids = library.importBooks([archive])
        XCTAssertEqual(ids.count, 1)

        let listing = library.listing()
        XCTAssertEqual(Set(listing.compactMap { $0["title"] as? String }), ["架上之书", "散装之书"])
        let imported = try XCTUnwrap(listing.first { $0["source"] as? String == "local" })
        let external = try XCTUnwrap(listing.first { $0["source"] as? String == "apple" })
        let importedID = try XCTUnwrap(imported["id"] as? String)
        let externalID = try XCTUnwrap(external["id"] as? String)
        XCTAssertEqual(importedID, ids[0])

        // reading state round-trips and shows up on the shelf
        library.saveState(["progress": ["fraction": 0.42, "updated": 1000.0], "finished": false], for: importedID)
        let again = try XCTUnwrap(library.listing().first { $0["id"] as? String == importedID })
        XCTAssertEqual(again["fraction"] as? Double, 0.42)

        // books on the external shelf are never deleted
        XCTAssertFalse(library.remove(externalID))
        XCTAssertTrue(FileManager.default.fileExists(atPath: folders.external[0].appendingPathComponent("Shelved.epub").path))
        XCTAssertTrue(library.remove(importedID))
        XCTAssertEqual(library.listing().count, 1)
    }
}
