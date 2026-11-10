import SwiftUI
import AppKit

@main
@MainActor
struct NativePreview {
    static func main() throws {
        _ = NSApplication.shared
        let args = CommandLine.arguments
        guard args.count >= 4 else { throw ServiceError(message: "Expected fixture, surface, and PNG path") }
        let state = try JSONDecoder().decode(InboxState.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
        let model = InboxModel(previewState: state); model.selectedNumber = state.prs.first(where: { $0.id == 104 })?.id ?? state.prs.first?.id
        if args[2] == "busy" { model.pendingActions[104] = "mark-ready" }
        if args[2] == "bulk" { model.selectingDrafts = true; model.selectDraft(104, selected: true) }
        if args[2] == "activity" { model.selectedNumber = nil }
        let width = args.count > 4 ? Double(args[4]) ?? 620 : 620
        let mode = args[2]
        let content: AnyView
        let size: NSSize
        switch mode {
        case "composer": content = AnyView(RunComposerPreview(model: model)); size = NSSize(width: width, height: 210)
        case "menu": content = AnyView(MenuContent(model: model)); size = NSSize(width: 370, height: 600)
        case "main", "busy", "bulk", "activity": content = AnyView(MainView(model: model)); size = NSSize(width: width, height: 650)
        case "sidebar": content = AnyView(PRSidebar(model: model)); size = NSSize(width: 260, height: 650)
        case "settings", "automation", "notifications", "spend": model.settingsTab = mode == "settings" ? "general" : mode; content = AnyView(SettingsView(model: model)); size = NSSize(width: 540, height: 560)
        default: content = AnyView(PRDetailView(model: model, initialTab: mode)); size = NSSize(width: width, height: 580)
        }
        NSApp.setActivationPolicy(.accessory)
        let window = model.showWindow(["main", "busy", "bulk", "activity"].contains(mode) ? "main" : "preview", title: "Woodshed", size: size, content: content)
        if ["settings", "automation", "notifications", "spend"].contains(mode) { model.configureSettingsToolbar(window) }
        window.minSize = .zero
        window.appearance = NSAppearance(named: args.last == "dark" ? .darkAqua : .aqua)
        if mode == "menu", let view = window.contentView { view.layoutSubtreeIfNeeded(); window.setContentSize(NSSize(width: 370, height: view.fittingSize.height)) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            // Layer-backed toolbar materials do not reliably render through cacheDisplay.
            // Prefer a WindowServer capture so the preview matches what is on screen.
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), args[3]]
            do {
                try capture.run(); capture.waitUntilExit()
                if capture.terminationStatus == 0 { print("Captured full window \(args[3])"); exit(0) }
            } catch { print("WindowServer capture unavailable: \(error.localizedDescription)") }
            guard let view = window.contentView?.superview else { exit(1) }
            view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { exit(1) }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
            do { try png.write(to: URL(fileURLWithPath: args[3])); print("Captured \(args[3])"); exit(0) }
            catch { print(error); exit(1) }
        }
        NSApp.run()
    }
}

@MainActor
private struct RunComposerPreview: View {
    @ObservedObject var model: InboxModel
    @FocusState private var focused: Bool
    var body: some View {
        if let record = model.state?.prs.first { RunComposer(record: record, model: model, focus: $focused).padding(20) }
    }
}
