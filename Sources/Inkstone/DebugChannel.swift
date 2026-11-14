import AppKit

extension ReaderWindow {
    /// Facts about the native window that can't be seen from inside the page.
    func debugInfo() -> [String: Any] {
        let window = self
        guard let content = window.contentView else { return [:] }
        var info: [String: Any] = [
            "frame": NSStringFromRect(window.frame),
            "contentLayoutRect": NSStringFromRect(window.contentLayoutRect),
            "fullScreen": window.styleMask.contains(.fullScreen),
            "title": window.title,
            "windowNumber": window.windowNumber,
            "visible": window.isVisible,
            "occluded": !window.occlusionState.contains(.visible),
            "miniaturized": window.isMiniaturized,
            "screen": window.screen.map { NSStringFromRect($0.frame) } ?? "none",
            "active": NSApp.isActive,
        ]
        if let close = window.standardWindowButton(.closeButton), let zoom = window.standardWindowButton(.zoomButton),
           let host = close.superview {
            info["closeButton"] = NSStringFromRect(host.convert(close.frame, to: nil))
            info["zoomButton"] = NSStringFromRect(host.convert(zoom.frame, to: nil))
        }
        // which view would receive a click in the middle of the title strip?
        if let frameView = content.superview {
            let point = NSPoint(x: content.bounds.midX, y: content.bounds.height - 20)
            let hit = frameView.hitTest(frameView.convert(point, from: nil))
            info["titleStripHit"] = hit.map { String(describing: type(of: $0)) } ?? "nil"
        }
        return info
    }
}
