import AppKit

// Package the selected source artwork at every standard macOS app-icon resolution.
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[2])
let sourceData = try Data(contentsOf: sourceURL)
guard let source = NSImage(data: sourceData), let original = NSBitmapImageRep(data: sourceData),
      original.pixelsWide == original.pixelsHigh, original.pixelsWide >= 1024 else {
    throw NSError(domain: "WoodshedIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Provide square app-icon artwork at least 1024 pixels wide"])
}
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

func render(_ pixels: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current!.imageInterpolation = .high
    NSGraphicsContext.current!.cgContext.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
    source.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    return bitmap.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try render(size * scale).write(to: directory.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
