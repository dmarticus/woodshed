import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: InboxModel
    @State private var query = ""
    @State private var priceModel = ""
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
            .onAppear { query = model.state?.settings?.watchQuery ?? ""; priceModel = model.state?.settings?.defaultModel ?? "" }
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
                LabeledContent("Concurrent runs") {
                    HStack { Text(String(model.state?.settings?.maxConcurrentJobs ?? 1)).monospacedDigit(); Stepper("", value: integerBinding("maxConcurrentJobs", model.state?.settings?.maxConcurrentJobs ?? 1), in: 1...8).labelsHidden().fixedSize() }
                }.disabled(!model.canSaveSettings)
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
                LabeledContent("Per-run cap") { TextField("Amount", value: doubleBinding("runCapUSD", model.state?.settings?.runCapUSD ?? 5), format: .currency(code: "USD").precision(.fractionLength(2))).labelsHidden().multilineTextAlignment(.trailing).frame(width: 95) }.disabled(!model.canSaveSettings)
                LabeledContent("Daily cap") { TextField("Amount", value: doubleBinding("dailyCapUSD", model.state?.settings?.dailyCapUSD ?? 20), format: .currency(code: "USD").precision(.fractionLength(2))).labelsHidden().multilineTextAlignment(.trailing).frame(width: 95) }.disabled(!model.canSaveSettings)
                Text("USD estimates at standard API rates, not your subscription bill. Caps stop runs when usage is reported; a model call can exceed the remaining estimate.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Token rates · USD per million") {
                Picker("Model", selection: $priceModel) {
                    Text("Choose model").tag("")
                    ForEach(model.state?.models ?? []) { Text($0.name).tag($0.id) }
                }
                if !priceModel.isEmpty {
                    rateField("Input", key: "input")
                    rateField("Cached input", key: "cached")
                    rateField("Cache writes", key: "cacheWrite")
                    rateField("Output", key: "output")
                    if let source = model.state?.models?.first(where: { $0.id == priceModel })?.price?.source { Button("Pricing reference ↗") { model.openExternal(source) }.buttonStyle(.link) }
                }
                Text("A model without configured token rates cannot start a capped run.").font(.caption).foregroundStyle(.secondary)
            }
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
    private func doubleBinding(_ key: String, _ value: Double) -> Binding<Double> { Binding(get: { value }, set: { next in Task { await model.updateSettings([key: next]) } }) }
    private var currentPrice: ModelPrice { model.state?.settings?.modelPrices?[priceModel] ?? model.state?.models?.first { $0.id == priceModel }?.price ?? ModelPrice(input: 0, cached: 0, output: 0, cacheWrite: 0) }
    private func rateField(_ title: String, key: String) -> some View {
        let price = currentPrice
        let value = key == "input" ? price.input : key == "cached" ? price.cached : key == "output" ? price.output : price.cacheWrite
        return LabeledContent(title) {
            TextField("USD", value: Binding(get: { value }, set: { next in
                var prices: [String: [String: Double]] = [:]
                for (id, rate) in model.state?.settings?.modelPrices ?? [:] { prices[id] = ["input": rate.input, "cached": rate.cached, "output": rate.output, "cacheWrite": rate.cacheWrite] }
                var selected = ["input": price.input, "cached": price.cached, "output": price.output, "cacheWrite": price.cacheWrite]
                selected[key] = next; prices[priceModel] = selected
                Task { await model.updateSettings(["modelPrices": prices]) }
            }), format: .currency(code: "USD").precision(.fractionLength(0...4))).labelsHidden().multilineTextAlignment(.trailing).frame(width: 95)
        }.disabled(!model.canSaveSettings)
    }
}
