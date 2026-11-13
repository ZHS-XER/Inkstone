import AppKit

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    // `delegate` is weakly held by the app; keep it alive for the whole run.
    withExtendedLifetime(delegate) { app.run() }
}
