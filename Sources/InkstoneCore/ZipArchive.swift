import Foundation
import Compression

/// A minimal read-only ZIP reader — just enough for EPUB files (stored and
/// deflated entries, no encryption, no multi-disk archives). The file is
/// memory-mapped, so opening a large book costs nothing until entries are read.
public final class ZipArchive {
    public struct Entry {
        public let name: String
        public let compressedSize: Int
        public let uncompressedSize: Int
        let method: UInt16
        let localHeaderOffset: Int
    }

    public enum ZipError: Error {
        case notAZipFile
        case corrupt(String)
        case unsupported(String)
    }

    public private(set) var entries: [String: Entry] = [:]
    public private(set) var order: [String] = []
    private let data: Data

    public init(url: URL) throws {
        data = try Data(contentsOf: url, options: .alwaysMapped)
        try readCentralDirectory()
    }

    public init(data: Data) throws {
        self.data = data
        try readCentralDirectory()
    }

    private func u16(_ offset: Int) -> Int {
        Int(data[data.startIndex + offset]) | Int(data[data.startIndex + offset + 1]) << 8
    }

    private func u32(_ offset: Int) -> Int {
        u16(offset) | u16(offset + 2) << 16
    }

    private func u64(_ offset: Int) -> Int {
        u32(offset) | u32(offset + 4) << 32
    }

    private func readCentralDirectory() throws {
        let count = data.count
        guard count >= 22 else { throw ZipError.notAZipFile }
        // The end-of-central-directory record sits at the very end, followed
        // only by an optional comment of at most 65535 bytes.
        var eocd = -1
        var i = count - 22
        let floor = max(0, count - 22 - 65535)
        while i >= floor {
            if u32(i) == 0x0605_4b50 { eocd = i; break }
            i -= 1
        }
        guard eocd >= 0 else { throw ZipError.notAZipFile }

        var total = u16(eocd + 10)
        var size = u32(eocd + 12)
        var offset = u32(eocd + 16)

        // ZIP64: the real numbers live in a separate record.
        if total == 0xffff || size == 0xffff_ffff || offset == 0xffff_ffff {
            let locator = eocd - 20
            guard locator >= 0, u32(locator) == 0x0706_4b50 else {
                throw ZipError.corrupt("missing zip64 locator")
            }
            let record = u64(locator + 8)
            guard record + 56 <= count, u32(record) == 0x0606_4b50 else {
                throw ZipError.corrupt("missing zip64 record")
            }
            total = u64(record + 32)
            size = u64(record + 40)
            offset = u64(record + 48)
        }
        guard offset >= 0, size >= 0, offset + size <= count else {
            throw ZipError.corrupt("central directory out of range")
        }

        var p = offset
        for _ in 0..<total {
            guard p + 46 <= count, u32(p) == 0x0201_4b50 else {
                throw ZipError.corrupt("bad central directory entry")
            }
            let method = UInt16(u16(p + 10))
            var compressed = u32(p + 20)
            var uncompressed = u32(p + 24)
            let nameLength = u16(p + 28)
            let extraLength = u16(p + 30)
            let commentLength = u16(p + 32)
            var local = u32(p + 42)
            guard p + 46 + nameLength + extraLength + commentLength <= count else {
                throw ZipError.corrupt("truncated central directory")
            }
            let nameData = data.subdata(in: data.startIndex + p + 46 ..< data.startIndex + p + 46 + nameLength)
            let name = String(data: nameData, encoding: .utf8)
                ?? String(decoding: nameData, as: UTF8.self)

            // ZIP64 extended information extra field
            if compressed == 0xffff_ffff || uncompressed == 0xffff_ffff || local == 0xffff_ffff {
                var e = p + 46 + nameLength
                let end = e + extraLength
                while e + 4 <= end {
                    let id = u16(e), len = u16(e + 2)
                    if id == 0x0001 {
                        var q = e + 4
                        if uncompressed == 0xffff_ffff, q + 8 <= end { uncompressed = u64(q); q += 8 }
                        if compressed == 0xffff_ffff, q + 8 <= end { compressed = u64(q); q += 8 }
                        if local == 0xffff_ffff, q + 8 <= end { local = u64(q) }
                        break
                    }
                    e += 4 + len
                }
            }

            if !name.hasSuffix("/") {
                if entries[name] == nil { order.append(name) }
                entries[name] = Entry(name: name, compressedSize: compressed,
                                      uncompressedSize: uncompressed, method: method,
                                      localHeaderOffset: local)
            }
            p += 46 + nameLength + extraLength + commentLength
        }
    }

    public func data(for name: String) throws -> Data? {
        guard let entry = entries[name] else { return nil }
        let h = entry.localHeaderOffset
        guard h >= 0, h + 30 <= data.count, u32(h) == 0x0403_4b50 else {
            throw ZipError.corrupt("bad local header for \(name)")
        }
        let start = h + 30 + u16(h + 26) + u16(h + 28)
        guard start >= 0, entry.compressedSize >= 0, start + entry.compressedSize <= data.count else {
            throw ZipError.corrupt("entry out of range: \(name)")
        }
        let raw = data.subdata(in: data.startIndex + start ..< data.startIndex + start + entry.compressedSize)
        switch entry.method {
        case 0:
            return raw
        case 8:
            return try inflate(raw, expected: entry.uncompressedSize, name: name)
        default:
            throw ZipError.unsupported("compression method \(entry.method) for \(name)")
        }
    }

    private func inflate(_ input: Data, expected: Int, name: String) throws -> Data {
        if expected == 0 { return Data() }
        guard expected > 0, expected < 1 << 31 else { throw ZipError.corrupt("absurd size for \(name)") }
        var output = Data(count: expected)
        let written = output.withUnsafeMutableBytes { dst -> Int in
            input.withUnsafeBytes { src -> Int in
                guard let d = dst.bindMemory(to: UInt8.self).baseAddress,
                      let s = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                // COMPRESSION_ZLIB is raw DEFLATE, which is exactly what ZIP stores.
                return compression_decode_buffer(d, expected, s, input.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard written == expected else {
            throw ZipError.corrupt("could not inflate \(name) (\(written) of \(expected) bytes)")
        }
        return output
    }
}
