// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Inkstone",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "InkstoneCore", targets: ["InkstoneCore"]),
        .executable(name: "Inkstone", targets: ["Inkstone"]),
    ],
    targets: [
        // Everything platform-neutral: EPUB containers, the library, and the
        // bridge that serves the web UI. Shared by the macOS and iOS shells.
        .target(name: "InkstoneCore"),
        .executableTarget(name: "Inkstone", dependencies: ["InkstoneCore"]),
        .testTarget(name: "InkstoneCoreTests", dependencies: ["InkstoneCore"]),
    ]
)
