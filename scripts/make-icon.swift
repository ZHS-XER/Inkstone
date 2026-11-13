// Renders the app icon and builds assets/AppIcon.icns.
//   swift scripts/make-icon.swift
import AppKit

let size: CGFloat = 1024

/// `fullBleed` draws the iOS variant: no rounded tile or shadow (the system masks it).
func render(fullBleed: Bool = false) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext

    // the standard macOS icon tile: 824pt square on a 1024pt canvas
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let radius: CGFloat = fullBleed ? 0 : 186
    let shape = CGPath(roundedRect: tile, cornerWidth: radius, cornerHeight: radius, transform: nil)

    if fullBleed {
        // stretch the tile over the whole canvas
        let s = size / tile.width
        ctx.translateBy(x: -tile.minX * s, y: -tile.minY * s)
        ctx.scaleBy(x: s, y: s)
    } else {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24,
                      color: NSColor(white: 0, alpha: 0.28).cgColor)
        ctx.addPath(shape)
        ctx.setFillColor(NSColor(srgbRed: 0.98, green: 0.976, blue: 0.96, alpha: 1).cgColor)
        ctx.fillPath()
        ctx.restoreGState()
    }

    // paper
    ctx.saveGState()
    ctx.addPath(shape)
    ctx.clip()
    let paper = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
        NSColor(srgbRed: 0.992, green: 0.984, blue: 0.965, alpha: 1).cgColor,
        NSColor(srgbRed: 0.945, green: 0.925, blue: 0.882, alpha: 1).cgColor,
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(paper, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

    // the inkstone: a dark slab with a shallow well of ink
    let slab = CGRect(x: 262, y: 236, width: 500, height: 552)
    let slabPath = CGPath(roundedRect: slab, cornerWidth: 86, cornerHeight: 86, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 34, color: NSColor(srgbRed: 0.2, green: 0.15, blue: 0.08, alpha: 0.38).cgColor)
    ctx.addPath(slabPath)
    ctx.setFillColor(NSColor(srgbRed: 0.17, green: 0.165, blue: 0.155, alpha: 1).cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(slabPath)
    ctx.clip()
    let stone = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
        NSColor(srgbRed: 0.27, green: 0.262, blue: 0.245, alpha: 1).cgColor,
        NSColor(srgbRed: 0.15, green: 0.146, blue: 0.137, alpha: 1).cgColor,
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(stone, start: CGPoint(x: 512, y: slab.maxY), end: CGPoint(x: 512, y: slab.minY), options: [])
    ctx.restoreGState()

    // the well: an inset rounded field, deeper toward the top where ink pools
    let well = slab.insetBy(dx: 58, dy: 58)
    let wellPath = CGPath(roundedRect: well, cornerWidth: 46, cornerHeight: 46, transform: nil)
    ctx.saveGState()
    ctx.addPath(wellPath)
    ctx.clip()
    let wellFill = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
        NSColor(srgbRed: 0.055, green: 0.055, blue: 0.052, alpha: 1).cgColor,
        NSColor(srgbRed: 0.12, green: 0.117, blue: 0.11, alpha: 1).cgColor,
        NSColor(srgbRed: 0.2, green: 0.195, blue: 0.183, alpha: 1).cgColor,
    ] as CFArray, locations: [0, 0.42, 1])!
    ctx.drawLinearGradient(wellFill, start: CGPoint(x: 512, y: well.maxY), end: CGPoint(x: 512, y: well.minY), options: [])
    // pooled ink with a soft sheen
    let pool = CGRect(x: well.minX - 40, y: well.maxY - 190, width: well.width + 80, height: 260)
    ctx.setFillColor(NSColor(srgbRed: 0.03, green: 0.03, blue: 0.03, alpha: 0.9).cgColor)
    ctx.fillEllipse(in: pool)
    ctx.setFillColor(NSColor(white: 1, alpha: 0.07).cgColor)
    ctx.fillEllipse(in: CGRect(x: well.minX + 40, y: well.maxY - 96, width: 200, height: 46))
    ctx.restoreGState()
    // rim light on the well
    ctx.addPath(wellPath)
    ctx.setStrokeColor(NSColor(white: 1, alpha: 0.07).cgColor)
    ctx.setLineWidth(3)
    ctx.strokePath()

    // a terracotta bookmark ribbon tucked under the stone
    ctx.saveGState()
    let ribbon = CGMutablePath()
    ribbon.move(to: CGPoint(x: 640, y: 924))
    ribbon.addLine(to: CGPoint(x: 724, y: 924))
    ribbon.addLine(to: CGPoint(x: 724, y: 812))
    ribbon.addLine(to: CGPoint(x: 682, y: 842))
    ribbon.addLine(to: CGPoint(x: 640, y: 812))
    ribbon.closeSubpath()
    ctx.addPath(ribbon)
    ctx.setFillColor(NSColor(srgbRed: 0.80, green: 0.40, blue: 0.26, alpha: 1).cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    ctx.restoreGState()

    if !fullBleed {
        // hairline edge
        ctx.addPath(shape)
        ctx.setStrokeColor(NSColor(white: 0, alpha: 0.08).cgColor)
        ctx.setLineWidth(2)
        ctx.strokePath()
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let rep = render()
let fm = FileManager.default
let root = URL(fileURLWithPath: fm.currentDirectoryPath)
let assets = root.appendingPathComponent("assets")
try? fm.createDirectory(at: assets, withIntermediateDirectories: true)
let master = assets.appendingPathComponent("icon-1024.png")
try rep.representation(using: .png, properties: [:])!.write(to: master)

let iconset = fm.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
try? fm.removeItem(at: iconset)
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
func run(_ tool: String, _ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = args
    try! p.run()
    p.waitUntilExit()
}
for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let px = points * scale
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    run("/usr/bin/sips", ["-z", "\(px)", "\(px)", master.path, "--out", iconset.appendingPathComponent(name).path])
}
run("/usr/bin/iconutil", ["-c", "icns", iconset.path, "-o", assets.appendingPathComponent("AppIcon.icns").path])
print("wrote assets/AppIcon.icns")

// iOS: one full-bleed 1024pt image, no alpha
let appiconset = root.appendingPathComponent("ios/App/Assets.xcassets/AppIcon.appiconset")
try fm.createDirectory(at: appiconset, withIntermediateDirectories: true)
let ios = render(fullBleed: true)
// re-encode without an alpha channel, which iOS icons must not have
let opaque = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
                       space: CGColorSpace(name: CGColorSpace.sRGB)!,
                       bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
opaque.setFillColor(NSColor.white.cgColor)
opaque.fill(CGRect(x: 0, y: 0, width: size, height: size))
opaque.draw(ios.cgImage!, in: CGRect(x: 0, y: 0, width: size, height: size))
let flat = NSBitmapImageRep(cgImage: opaque.makeImage()!)
try flat.representation(using: .png, properties: [:])!.write(to: appiconset.appendingPathComponent("icon-1024.png"))
print("wrote ios AppIcon")
