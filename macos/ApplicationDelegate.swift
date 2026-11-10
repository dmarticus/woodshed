import AppKit

@MainActor
final class WoodshedApplicationDelegate: NSObject, NSApplicationDelegate {
    let model: InboxModel
    private var connectionTask: Task<Void, Never>?

    override convenience init() { self.init(model: InboxModel()) }
    init(model: InboxModel) { self.model = model; super.init() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if let iconURL = Bundle.main.url(forResource: "Woodshed", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) { NSApp.applicationIconImage = icon }
        model.showMain()
        if !model.preview { connectionTask = Task { await model.run() } }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        model.showMain()
        return false // The existing main window is restored here, including when minimized.
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { connectionTask?.cancel() }
}
