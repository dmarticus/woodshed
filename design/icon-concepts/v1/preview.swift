import AppKit
import SwiftUI

struct Concept: Identifiable {
    let id: String
    let title: String
    let detail: String
    let image: NSImage
}
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let concepts = [
    ("A", "Workshop", "A warm place to make things", "a-workshop.png"),
    ("B", "Joinery W", "A distinctive wooden monogram", "b-joinery.png"),
    ("C", "Anvil", "Solid, dependable maintenance", "c-anvil.png"),
    ("D", "Hand plane", "Smoothing the rough edges", "d-hand-plane.png"),
].map { Concept(id: $0.0, title: $0.1, detail: $0.2, image: NSImage(contentsOf: directory.appendingPathComponent($0.3))!) }

struct Comparison: View {
    func icon(_ concept: Concept, size: CGFloat) -> some View {
        Image(nsImage: concept.image).resizable().interpolation(.high).aspectRatio(contentMode: .fit).frame(width: size, height: size)
    }
    func strip(_ label: String, size: CGFloat, dark: Bool) -> some View {
        HStack(spacing: 0) {
            Text(label).font(.system(size: 12, weight: .medium)).frame(width: 150, alignment: .leading)
            ForEach(concepts) { concept in
                HStack(spacing: 12) { icon(concept, size: size); Text(concept.id).font(.system(size: 11, weight: .medium)).opacity(0.65) }.frame(maxWidth: .infinity)
            }
        }.padding(.horizontal, 24).padding(.vertical, 14)
            .foregroundStyle(dark ? Color.white : Color.black)
            .background(dark ? Color(red: 0.13, green: 0.14, blue: 0.16) : Color(red: 0.93, green: 0.93, blue: 0.94))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Woodshed").font(.system(size: 27, weight: .semibold))
                Text("Icon directions").font(.system(size: 19)).foregroundStyle(.secondary)
                Spacer()
                Text("A · B · C · D").font(.system(size: 12)).foregroundStyle(.secondary)
            }.padding(.horizontal, 32).padding(.top, 28)
            HStack(alignment: .top, spacing: 20) {
                ForEach(concepts) { concept in
                    VStack(alignment: .center, spacing: 6) {
                        icon(concept, size: 208)
                        Text(concept.id + "  " + concept.title).font(.system(size: 16, weight: .semibold))
                        Text(concept.detail).font(.system(size: 12)).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity)
                }
            }.padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 24)
            strip("Dock · 64 pt", size: 64, dark: true)
            strip("Dock · 64 pt", size: 64, dark: false)
            strip("Small · 32 pt", size: 32, dark: true)
            strip("Small · 16 pt", size: 16, dark: false)
            Text("Concept previews · original source images preserved").font(.system(size: 11)).foregroundStyle(.secondary).padding(.horizontal, 32).padding(.vertical, 18)
        }.frame(width: 1080).foregroundStyle(Color.black).background(Color.white)
            .environment(\.colorScheme, .light)
    }
}

_ = NSApplication.shared
let host = NSHostingView(rootView: Comparison())
host.setFrameSize(host.fittingSize)
host.layoutSubtreeIfNeeded()
let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
host.cacheDisplay(in: host.bounds, to: bitmap)
try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("comparison.png"))
print("Rendered comparison at \(Int(host.bounds.width)) × \(Int(host.bounds.height)) points")
