import SwiftUI

struct WoodshedStatusIcon: View {
    @ObservedObject var model: InboxModel
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Image(systemName: !model.connected ? "wifi.slash" : model.mode == .paused ? "pause.circle" : model.mode == .auto ? "hammer.fill" : "hammer").font(.system(size: 16))
            if model.attentionCount > 0 { Circle().fill(.orange).frame(width: 5, height: 5).offset(x: 3, y: -2) }
        }.frame(width: 21, height: 18).accessibilityLabel("Woodshed, \(model.mode.label), \(model.attentionCount) need you")
    }
}
@main
struct WoodshedApp: App {
    @NSApplicationDelegateAdaptor(WoodshedApplicationDelegate.self) private var appDelegate
    private var model: InboxModel { appDelegate.model }
    var body: some Scene {
        MenuBarExtra { MenuContent(model: model) } label: {
            WoodshedStatusIcon(model: model)
        }.menuBarExtraStyle(.window)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Open Woodshed") { model.showMain() }.keyboardShortcut("o")
                Button("Settings…") { model.showSettings() }.keyboardShortcut(",")
            }
        }
    }
}
