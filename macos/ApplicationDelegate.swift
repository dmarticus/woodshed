import AppKit
import SwiftUI

@MainActor
final class WoodshedApplicationDelegate: NSObject, NSApplicationDelegate {
    let model: InboxModel
    private var connectionTask: Task<Void, Never>?
    private var menuBar: MenuBarPopover?

    override convenience init() { self.init(model: InboxModel()) }
    init(model: InboxModel) { self.model = model; super.init() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if let iconURL = Bundle.main.url(forResource: "Woodshed", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) { NSApp.applicationIconImage = icon }
        menuBar = MenuBarPopover(model: model)
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

/// The menu bar item opens a popover anchored to the icon, with an arrow, sized to its content.
@MainActor
final class MenuBarPopover: NSObject, NSPopoverDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let popover = NSPopover()
    private let model: InboxModel
    init(model: InboxModel) {
        self.model = model
        super.init()
        let controller = NSHostingController(rootView: MenuContent(model: model))
        controller.sizingOptions = [.preferredContentSize]
        popover.contentViewController = controller
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        guard let button = item.button else { return }
        let icon = PassthroughHostingView(rootView: WoodshedStatusIcon(model: model))
        icon.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(icon)
        NSLayoutConstraint.activate([icon.centerXAnchor.constraint(equalTo: button.centerXAnchor), icon.centerYAnchor.constraint(equalTo: button.centerYAnchor)])
        item.length = 30
        button.setAccessibilityLabel("Woodshed")
        button.target = self
        button.action = #selector(toggle)
        model.closeMenu = { [weak self] in self?.popover.performClose(nil) }
    }
    @objc func toggle() {
        guard let button = item.button else { return }
        if popover.isShown { popover.performClose(nil); return }
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        button.highlight(true)
        Task { await model.refresh() }
    }
    func popoverDidClose(_ notification: Notification) { item.button?.highlight(false) }
}
/// Hosts the SwiftUI icon inside the status bar button without taking its clicks.
private final class PassthroughHostingView<Content: View>: NSHostingView<Content> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
