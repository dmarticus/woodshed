import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: InboxModel
    @State private var query = ""
    @State private var priceModel = ""
    @State private var showRates = false
    @StateObject private var limits = AmountSettingsDraft(maximum: 10_000, fractionDigits: 2)
    @StateObject private var rates = AmountSettingsDraft(maximum: 100_000, fractionDigits: 4)
    var body: some View {
        VStack(spacing: 0) {
            Form {
                switch model.settingsTab {
                case "automation": automation
                case "notifications": notifications
                case "spend": spend
                default: general
                }
            }.formStyle(.grouped)
            if let error = model.actionError ?? model.connectionError { ErrorBanner(text: error).padding([.horizontal, .bottom], 12) }
            if model.serviceActionPending || model.pendingMode != nil { ProgressView().controlSize(.small).padding(.bottom, 8) }
        }.frame(minWidth: 490, minHeight: 440).background(Color(nsColor: .windowBackgroundColor))
            .onAppear { query = model.state?.settings?.watchQuery ?? ""; priceModel = model.state?.settings?.defaultModel ?? ""; syncAmounts() }
            .onChange(of: model.state?.settings?.runCapUSD) { _, _ in syncAmounts() }
            .onChange(of: model.state?.settings?.dailyCapUSD) { _, _ in syncAmounts() }
            .onChange(of: priceModel) { _, _ in rates.reset(priceValues) }
            .onChange(of: priceValues) { _, _ in rates.receive(priceValues) }
            .task(id: query) {
                guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, query != model.state?.settings?.watchQuery, model.state?.settings?.watchFilter == "query" else { return }
                do { try await Task.sleep(for: .milliseconds(600)) } catch { return }
                await model.updateSettings(["watchQuery": query])
            }
    }
    private var general: some View {
        Group {
            Section {
                LabeledContent("Mode") { ModePicker(model: model) }
                Text("Watch follows PRs. Auto maintains them. Paused queues new runs.").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                LabeledContent("Repository", value: model.state?.repository ?? "Connecting…")
                Picker("Watch PRs by", selection: textBinding("watchFilter", model.state?.settings?.watchFilter ?? "mine")) {
                    Text("Me").tag("mine")
                    Text("Me + review requests").tag("mine-and-reviews")
                    Text("Custom query").tag("query")
                }.disabled(!model.canSaveSettings)
                if model.state?.settings?.watchFilter == "query" { TextField("GitHub PR search", text: $query).textFieldStyle(.roundedBorder) }
                Text("Review requests from other authors are watched; Auto only changes your own PRs.").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                LabeledContent("Controller", value: model.connected ? "Connected" : "Unavailable")
                LabeledContent("Runs on", value: model.remoteMachine ?? "This Mac")
            }
        }
    }
    private var automation: some View {
        Group {
            Section {
                Picker("Default model", selection: textBinding("defaultModel", model.state?.settings?.defaultModel ?? "")) {
                    Text("Codex default").tag("")
                    ForEach(model.state?.models ?? []) { Text($0.name).tag($0.id) }
                }.disabled(!model.canSaveSettings)
                Picker("Concurrent agents", selection: textBinding("concurrencyMode", model.state?.settings?.concurrencyMode ?? "fixed")) {
                    Text("Automatic").tag("adaptive")
                    Text("Fixed limit").tag("fixed")
                }.disabled(!model.canSaveSettings)
                if model.state?.settings?.concurrencyMode == "adaptive" {
                    LabeledContent("CPU target") {
                        HStack { Text("\(model.state?.settings?.cpuTargetPercent ?? 80)%").monospacedDigit(); Stepper("", value: integerBinding("cpuTargetPercent", model.state?.settings?.cpuTargetPercent ?? 80), in: 20...95, step: 5).labelsHidden().fixedSize() }
                    }.disabled(!model.canSaveSettings)
                    LabeledContent("Memory target") {
                        HStack { Text("\(model.state?.settings?.memoryTargetPercent ?? 80)%").monospacedDigit(); Stepper("", value: integerBinding("memoryTargetPercent", model.state?.settings?.memoryTargetPercent ?? 80), in: 50...90, step: 5).labelsHidden().fixedSize() }
                    }.disabled(!model.canSaveSettings)
                    Text("Starts agents one at a time while the server has headroom. Busy agents continue; new starts wait when usage reaches a target.").font(.caption).foregroundStyle(.secondary)
                } else {
                    LabeledContent("Maximum agents") {
                        HStack { Text(String(model.state?.settings?.maxConcurrentJobs ?? 1)).monospacedDigit(); Stepper("", value: integerBinding("maxConcurrentJobs", model.state?.settings?.maxConcurrentJobs ?? 1), in: 1...128).labelsHidden().fixedSize() }
                    }.disabled(!model.canSaveSettings)
                }
                LabeledContent("Attempts before asking you") {
                    HStack { Text(String(model.state?.settings?.maxAttempts ?? 3)).monospacedDigit(); Stepper("", value: integerBinding("maxAttempts", model.state?.settings?.maxAttempts ?? 3), in: 1...10).labelsHidden().fixedSize() }
                }.disabled(!model.canSaveSettings)
            }
            Section {
                Toggle("Escalate model after a failed attempt", isOn: boolBinding("escalateOnRetry", model.state?.settings?.escalateOnRetry ?? false)).disabled(!model.canSaveSettings)
                if model.state?.settings?.escalateOnRetry == true {
                    Picker("Retry model", selection: textBinding("retryModel", model.state?.settings?.retryModel ?? "")) {
                        Text("Use default").tag("")
                        ForEach(model.state?.models ?? []) { Text($0.name).tag($0.id) }
                    }.disabled(!model.canSaveSettings)
                }
                Text("You can choose a different model beside Start run without changing the default.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private var notifications: some View {
        Group {
            Section {
                HStack {
                    Label(model.notificationsEnabled ? "Notifications enabled" : "Notifications are off", systemImage: model.notificationsEnabled ? "bell" : "bell.badge")
                    Spacer()
                    Button("System settings…") { Task { await model.enableNotifications() } }.disabled(model.preview)
                }
                Text("Notifications bring decisions and finished runs to you. CI and review waits stay quiet.").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                Toggle("Decisions that need me", isOn: $model.notifyNeeds)
                Toggle("PRs ready to merge", isOn: $model.notifyReady)
                Toggle("Finished agent runs", isOn: $model.notifyFinished)
            }.disabled(!model.notificationsEnabled)
            if !model.notificationsEnabled { Text("No notifications will arrive until you turn them on in System Settings.").font(.caption).foregroundStyle(.secondary) }
            Section { Text("Reply, Retry, Skip run, or Open directly from a banner. Permission requests open the run for an explicit response.").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var spend: some View {
        Group {
            Section {
                Text(model.spendFooter).font(.callout)
                amountField("Per-run cap", key: "runCapUSD", draft: limits)
                amountField("Daily cap", key: "dailyCapUSD", draft: limits)
                amountActions(limits, label: "Save limits") { values in
                    await model.updateSettings(values.mapValues { $0 as Any }) ? nil : model.actionError ?? "Couldn’t save limits. Your edits are kept."
                }
                Text("Limits use estimated API costs, not your subscription bill. An in-flight model call can exceed the remaining estimate.").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                DisclosureGroup("Token rates (advanced)", isExpanded: $showRates) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("USD per million tokens. These rates are used to estimate spend.").font(.caption).foregroundStyle(.secondary)
                        Picker("Model", selection: $priceModel) {
                            Text("Choose model").tag("")
                            ForEach(model.state?.models ?? []) { Text($0.name).tag($0.id) }
                        }.disabled(rates.hasChanges || rates.saving)
                        if !priceModel.isEmpty {
                            amountField("Input", key: "input", draft: rates)
                            amountField("Cached input", key: "cached", draft: rates)
                            amountField("Cache writes", key: "cacheWrite", draft: rates)
                            amountField("Output", key: "output", draft: rates)
                            amountActions(rates, label: "Save rates") { values in
                                var prices: [String: [String: Double]] = [:]
                                for (id, rate) in model.state?.settings?.modelPrices ?? [:] { prices[id] = ["input": rate.input, "cached": rate.cached, "output": rate.output, "cacheWrite": rate.cacheWrite] }
                                prices[priceModel] = values
                                return await model.updateSettings(["modelPrices": prices]) ? nil : model.actionError ?? "Couldn’t save rates. Your edits are kept."
                            }
                            if let source = model.state?.models?.first(where: { $0.id == priceModel })?.price?.source { Button("Pricing reference") { model.openExternal(source) }.buttonStyle(.link) }
                        }
                        Text("A model without configured token rates cannot start a capped run.").font(.caption).foregroundStyle(.secondary)
                    }.padding(.top, 8)
                }
            }
        }
    }
    private var limitValues: [String: Double] { ["runCapUSD": model.state?.settings?.runCapUSD ?? 5, "dailyCapUSD": model.state?.settings?.dailyCapUSD ?? 20] }
    private var priceValues: [String: Double] { ["input": currentPrice.input, "cached": currentPrice.cached, "cacheWrite": currentPrice.cacheWrite, "output": currentPrice.output] }
    private func syncAmounts() { limits.receive(limitValues); rates.receive(priceValues) }
    private func amountField(_ title: String, key: String, draft: AmountSettingsDraft) -> some View {
        LabeledContent(title) {
            HStack(spacing: 5) {
                Text("$").foregroundStyle(.secondary)
                TextField(title, text: Binding(get: { draft.text[key] ?? "" }, set: { draft.edit(key, text: $0) }))
                    .labelsHidden().textFieldStyle(.roundedBorder).multilineTextAlignment(.trailing).frame(width: 115)
                    .accessibilityLabel(title + " in US dollars")
            }
        }.disabled(draft.saving)
    }
    private func amountActions(_ draft: AmountSettingsDraft, label: String, save: @escaping @MainActor ([String: Double]) async -> String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(draft.saving ? "Saving…" : label) { Task { await draft.save(using: save) } }
                    .buttonStyle(.borderedProminent).disabled(!model.canSaveSettings || draft.saving || !draft.hasChanges || draft.validationError != nil)
                if draft.saving { ProgressView().controlSize(.small) }
                else if draft.hasChanges { Button("Discard changes") { draft.reset(draft === limits ? limitValues : priceValues) } }
                else if draft.saved { Label("Saved", systemImage: "checkmark").font(.callout).foregroundStyle(.secondary) }
            }
            if let error = draft.error ?? (draft.hasChanges ? draft.validationError : nil) { Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            else if draft.hasChanges && !draft.saving { Text("Changes apply when you save.").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func textBinding(_ key: String, _ value: String) -> Binding<String> {
        Binding(get: { value }, set: { next in Task {
            var patch: [String: Any] = [key: next]
            if key == "watchFilter" && next == "query" && query.isEmpty { query = "author:@me"; patch["watchQuery"] = query }
            await model.updateSettings(patch)
        } })
    }
    private func boolBinding(_ key: String, _ value: Bool) -> Binding<Bool> { Binding(get: { value }, set: { next in Task { await model.updateSettings([key: next]) } }) }
    private func integerBinding(_ key: String, _ value: Int) -> Binding<Int> { Binding(get: { value }, set: { next in Task { await model.updateSettings([key: next]) } }) }
    private var currentPrice: ModelPrice { model.state?.settings?.modelPrices?[priceModel] ?? model.state?.models?.first { $0.id == priceModel }?.price ?? ModelPrice(input: 0, cached: 0, output: 0, cacheWrite: 0) }
}

// A live controller refresh must never become the text field's editing buffer.
@MainActor
final class AmountSettingsDraft: ObservableObject {
    @Published private(set) var text: [String: String] = [:]
    @Published private(set) var saving = false
    @Published private(set) var saved = false
    @Published private(set) var error: String?
    private var confirmed: [String: Double] = [:]
    let maximum: Double
    let fractionDigits: Int
    let locale: Locale
    init(maximum: Double, fractionDigits: Int, locale: Locale = .current) { self.maximum = maximum; self.fractionDigits = fractionDigits; self.locale = locale }
    func edit(_ key: String, text value: String) { text[key] = value; error = nil; saved = false }
    private func formatted(_ value: Double) -> String { value.formatted(.number.locale(locale).grouping(.never).precision(.fractionLength(0...fractionDigits))) }
    private func amount(_ value: String) -> Double? {
        let separator = locale.decimalSeparator ?? "."
        let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let escaped = NSRegularExpression.escapedPattern(for: separator)
        guard raw.range(of: "^[0-9]+(?:" + escaped + "[0-9]{0," + String(fractionDigits) + "})?$", options: .regularExpression) != nil,
              let number = Double(raw.replacingOccurrences(of: separator, with: ".")), number.isFinite, number >= 0, number <= maximum else { return nil }
        return number
    }
    var hasChanges: Bool { text.contains { key, value in amount(value) != confirmed[key] } }
    var validationError: String? { text.values.contains { amount($0) == nil } ? "Enter an amount from 0 to \(maximum.formatted(.number.locale(locale))) with up to \(fractionDigits) decimal places." : nil }
    func receive(_ values: [String: Double]) {
        guard !saving else { return }
        for (key, value) in values {
            let untouched = text[key] == nil || text[key].flatMap(amount) == confirmed[key]
            confirmed[key] = value
            if untouched { text[key] = formatted(value) }
        }
    }
    func reset(_ values: [String: Double]) { confirmed = values; text = values.mapValues(formatted); error = nil; saved = false }
    @discardableResult
    func save(using submit: @MainActor ([String: Double]) async -> String?) async -> Bool {
        guard !saving, hasChanges else { return false }
        guard validationError == nil else { error = validationError; return false }
        let submittedText = text
        let values = text.compactMapValues(amount)
        saving = true; saved = false; error = nil
        let failure = await submit(values)
        saving = false
        if let failure { error = failure; return false }
        confirmed = values
        for (key, value) in values where text[key] == submittedText[key] { text[key] = formatted(value) }
        saved = !hasChanges
        return true
    }
}
