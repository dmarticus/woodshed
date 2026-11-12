import SwiftUI

@main
struct WoodshedApp: App {
    @NSApplicationDelegateAdaptor(WoodshedApplicationDelegate.self) private var appDelegate
    private var model: InboxModel { appDelegate.model }
    var body: some Scene {
        // The menu bar popover is an NSStatusItem owned by the app delegate; this scene only carries the app menu commands.
        Settings { EmptyView() }
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { model.showSettings() }.keyboardShortcut(",")
            }
            CommandGroup(after: .appInfo) {
                Button("Open Woodshed") { model.showMain() }.keyboardShortcut("o")
            }
        }
    }
}
