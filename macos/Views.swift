import SwiftUI

struct ModePicker: View {
    @ObservedObject var model: InboxModel
    var body: some View {
        Picker("Mode", selection: Binding(get: { model.pendingMode ?? model.mode }, set: { model.setMode($0) })) {
            ForEach(Mode.allCases) { Text($0.label).tag($0) }
        }.pickerStyle(.segmented).labelsHidden().fixedSize().disabled(!model.canSaveSettings || model.pendingMode != nil)
    }
}
struct FeedbackText: View {
    let text: String
    var body: some View {
        Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { $0.scheme == "https" ? .systemAction : .discarded })
    }
}
struct ErrorBanner: View {
    let text: String
    var refresh: (() -> Void)? = nil
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Label(text, systemImage: "exclamationmark.circle").font(.callout).textSelection(.enabled)
            Spacer(minLength: 8)
            if let refresh { Button("Refresh", action: refresh).buttonStyle(.bordered) }
        }.foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading).padding(10).background(.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 7))
    }
}
struct Fold<Content: View>: View {
    let title: String
    @State private var expanded: Bool
    let content: Content
    init(_ title: String, expanded: Bool = false, @ViewBuilder content: () -> Content) { self.title = title; _expanded = State(initialValue: expanded); self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 6) { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).rotationEffect(.degrees(expanded ? 90 : 0)).frame(width: 12); Text(title); Spacer(minLength: 0) }
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded { content.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 18) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
struct GitHubConnectionBanner: View {
    @ObservedObject var model: InboxModel
    var body: some View {
        if let message = model.githubConnectionIssue {
            HStack(alignment: .top) { Label(message, systemImage: "person.crop.circle.badge.exclamationmark").font(.callout); Spacer(); Button("Reconnect GitHub") { model.reconnectGitHub() }.disabled(model.preview) }
                .padding(12).background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}
struct MenuContent: View {
    @ObservedObject var model: InboxModel
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { Text("Woodshed").font(.headline); Spacer(); if model.connected { ModePicker(model: model) } else { Label("Disconnected", systemImage: "wifi.slash").font(.caption).foregroundStyle(.secondary) } }.padding(16)
            Divider()
            if !model.connected {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.connectionSummary).font(.callout)
                    if let error = model.connectionError { Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    Button("Reconnect") { Task { await model.refresh() } }.buttonStyle(.borderedProminent)
                }.padding(16)
            }
            GitHubConnectionBanner(model: model).padding(.horizontal, 12)
            if model.notificationBroken {
                Button { Task { await model.enableNotifications() } } label: { Label("Notifications are off · Open settings", systemImage: "bell.badge").font(.callout).frame(maxWidth: .infinity, alignment: .leading).padding(10).background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8)) }.buttonStyle(.plain).padding(12)
            }
            if !model.attention.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Needs you").font(.caption).foregroundStyle(.secondary)
                    ForEach(model.attention) { record in
                        Button { model.showMain(record.id) } label: {
                            HStack(alignment: .top, spacing: 9) {
                                Circle().fill(.orange).frame(width: 7, height: 7).padding(.top, 5)
                                VStack(alignment: .leading, spacing: 3) { Text(record.displayTitle).lineLimit(2); Text(record.decision.title ?? record.decision.reason).font(.caption).foregroundStyle(.secondary).lineLimit(2) }.frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(10).background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain).contextMenu { prContextMenu(record) }
                    }
                }.padding(12)
            }
            if !model.running.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(model.mode == .paused ? "\(model.running.count) finishing · nothing new will start" : "Running").font(.caption).foregroundStyle(.secondary)
                    ForEach(model.running) { record in
                        Button { model.showMain(record.id) } label: {
                            HStack(spacing: 9) { ProgressView().controlSize(.mini); Text(record.displayTitle).lineLimit(1); Spacer(minLength: 6); Text(model.prSpend(record)).font(.caption).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain).contextMenu { prContextMenu(record) }
                    }
                }.padding(12)
            }
            if !model.draftPRs.isEmpty {
                Fold("\(model.draftPRs.count) drafts") {
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(model.draftPRs) { record in
                            Button { model.showMain(record.id) } label: { Label(record.displayTitle, systemImage: "doc.text").lineLimit(1) }
                                .buttonStyle(.plain).contextMenu { prContextMenu(record) }
                        }
                    }
                }.padding(12)
            }
            if !model.queued.isEmpty { statusGroup("\(model.queued.count) queued", records: model.queued, icon: "tray") }
            if !model.waiting.isEmpty { statusGroup("\(model.waiting.count) waiting", records: model.waiting, icon: "clock") }
            if !model.pausedPRs.isEmpty { statusGroup("\(model.pausedPRs.count) paused", records: model.pausedPRs, icon: "pause.circle") }
            if !model.ready.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    Text("Ready to merge").font(.caption).foregroundStyle(.secondary)
                    ForEach(model.ready) { record in Button { model.showMain(record.id) } label: { Label(record.displayTitle, systemImage: "checkmark.circle.fill").foregroundStyle(.green).lineLimit(1) }.buttonStyle(.plain).contextMenu { prContextMenu(record) } }
                }.padding(12)
            }
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                Text(model.spendFooter).font(.caption).foregroundStyle(.secondary).opacity(model.connected ? 1 : 0.4)
                Button("Open Woodshed") { model.showMain() }.buttonStyle(.plain).keyboardShortcut("o")
                Button("Settings…") { model.showSettings() }.buttonStyle(.plain).keyboardShortcut(",")
                Button("Quit Woodshed") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).keyboardShortcut("q")
            }.padding(16)
        }.frame(width: 370).background(Color(nsColor: .windowBackgroundColor))
    }
    private func statusGroup(_ title: String, records: [PullRequestRecord], icon: String) -> some View {
        Fold(title) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(records) { record in
                    Button { model.showMain(record.id) } label: {
                        HStack(alignment: .top, spacing: 9) {
                            Image(systemName: icon).frame(width: 14).padding(.top, 2).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(record.displayTitle).lineLimit(2)
                                if let status = model.listStatus(record) { Text(status).font(.caption).foregroundStyle(.secondary).lineLimit(2).help(status) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }.buttonStyle(.plain).contextMenu { prContextMenu(record) }
                }
            }
        }.padding(12).opacity(model.connected ? 1 : 0.4)
    }
    @ViewBuilder private func prContextMenu(_ record: PullRequestRecord) -> some View {
        Button("Open PR") { model.track("open_pr", number: record.id); model.openGitHub(record.snapshot.url) }
        Button("Refresh") { Task { await model.recheck(record) } }.disabled(!model.canAct(on: record))
        Button("Request Stamphog approval") { Task { await model.act("request-approval", on: record) } }.disabled(!model.canRequestApproval(record)).help(record.approval?.reason ?? "Refresh this PR to check approval availability")
        Divider()
        if record.snapshot.draft {
            if record.canMarkReady == true { Button("Mark ready for review") { Task { await model.act("mark-ready", on: record) } }.disabled(!model.canAct(on: record)) }
        } else {
            if record.canMarkReady == true { Button("Convert to draft") { Task { await model.act("mark-draft", on: record) } }.disabled(!model.canAct(on: record)) }
            if record.isWatched { Button("Start task…") { model.startTask(record) } }
        }
    }
}
struct MainView: View {
    @ObservedObject var model: InboxModel
    var body: some View {
        HSplitView {
            PRSidebar(model: model).frame(minWidth: 240, idealWidth: 260, maxWidth: 280)
            Group {
                if model.selected != nil { PRDetailView(model: model).id(model.selectedNumber) }
                else if model.state == nil {
                    VStack(spacing: 12) {
                        if model.connectionError == nil { ProgressView().controlSize(.small) }
                        Text(model.connectionError == nil ? "Connecting to Woodshed…" : "Controller unavailable").font(.headline)
                        if let error = model.connectionError {
                            Text(error).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            Button("Reconnect") { Task { await model.refresh() } }.disabled(model.refreshing)
                        }
                    }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else { ActivityView(model: model) }
            }.frame(minWidth: 440, maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .background(Button("") { if let record = model.selected { Task { await model.recheck(record) } } else { Task { await model.perform("api/refresh") } } }.keyboardShortcut("r").hidden())
    }
}
struct PRSidebar: View {
    @ObservedObject var model: InboxModel
    @State private var reviewTarget: PullRequestRecord?
    @State private var reviewer = ""
    var body: some View {
        VStack(spacing: 0) {
            List(selection: Binding(get: { model.selectedNumber }, set: { if let number = $0 { model.selectedNumber = number } })) {
                if let state = model.state, !state.prs.contains(where: { $0.snapshot.state == "OPEN" }) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No open PRs").font(.headline)
                        Text("PRs matching your watch settings will appear here.").font(.callout).foregroundStyle(.secondary)
                        Button("Watch settings…") { model.showSettings() }.buttonStyle(.link)
                    }.padding(.vertical, 12).listRowSeparator(.hidden)
                }
                if !model.attention.isEmpty { Section("Needs you") { ForEach(model.attention) { sidebarRow($0, attention: true) } } }
                if !model.running.isEmpty { Section(model.mode == .paused ? "Finishing" : "Running") { ForEach(model.running) { sidebarRow($0, running: true) } } }
                if !model.draftPRs.isEmpty {
                    Section {
                        ForEach(model.draftPRs) { record in sidebarRow(record, selectable: true) }
                    } header: {
                        HStack {
                            Text("Drafts · \(model.draftPRs.count)")
                            Spacer(minLength: 4)
                            Button(model.selectingDrafts ? "Done" : "Select") {
                                if model.selectingDrafts { model.finishDraftSelection() } else { model.selectingDrafts = true }
                            }.buttonStyle(.link).font(.caption).disabled(model.promotingDrafts)
                        }
                        if model.selectingDrafts {
                            HStack {
                                Text("\(model.selectedDrafts.count) selected").font(.caption).foregroundStyle(.secondary)
                                Spacer(minLength: 4)
                                Button("Mark ready") { model.promoteSelectedDrafts() }
                                    .buttonStyle(.bordered).controlSize(.small)
                                    .disabled(model.eligibleDrafts.isEmpty || model.promotingDrafts)
                            }.padding(.vertical, 4)
                        }
                    }
                }
                if !model.queued.isEmpty { Section("Queued") { ForEach(model.queued) { sidebarRow($0) } } }
                if !model.ready.isEmpty { Section("Ready to merge") { ForEach(model.ready) { sidebarRow($0) } } }
                if !model.waiting.isEmpty { Section("Waiting") { ForEach(model.waiting) { sidebarRow($0) } } }
                if !model.pausedPRs.isEmpty { Section("Paused") { ForEach(model.pausedPRs) { sidebarRow($0) } } }
                if !model.unwatched.isEmpty { Section("Not watching") { ForEach(model.unwatched) { sidebarRow($0) } } }
            }.listStyle(.plain).scrollContentBackground(.hidden)
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text(model.spendFooter).font(.caption2).foregroundStyle(.secondary)
                HStack { Button("All runs") { model.selectedNumber = nil }.buttonStyle(.link); Spacer(); Button { model.showSettings() } label: { Image(systemName: "gearshape") }.buttonStyle(.borderless) }
            }.padding(12)
        }.frame(maxHeight: .infinity).background(Color(nsColor: .windowBackgroundColor))
        .alert("Request review", isPresented: Binding(get: { reviewTarget != nil }, set: { if !$0 { reviewTarget = nil } })) {
            TextField("GitHub username or organization/team", text: $reviewer)
            Button("Cancel", role: .cancel) { reviewTarget = nil }
            Button("Request review") {
                if let record = reviewTarget {
                    Task { _ = await model.act("reviewer", on: record, reviewer: reviewer) }
                }
                reviewTarget = nil
            }.disabled(reviewer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reviewTarget.map { !model.canAct(on: $0) } != false)
        }
    }
    private func sidebarRow(_ record: PullRequestRecord, attention: Bool = false, running: Bool = false, selectable: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Group {
                if selectable && model.selectingDrafts {
                    Toggle("Select \(record.displayTitle) for ready", isOn: Binding(
                        get: { model.selectedDrafts.contains(record.id) },
                        set: { model.selectDraft(record.id, selected: $0) }
                    )).toggleStyle(.checkbox).labelsHidden().controlSize(.small)
                        .disabled(record.canMarkReady != true || model.promotingDrafts)
                } else if model.pendingActions[record.id] != nil || running { ProgressView().controlSize(.mini) }
                else if model.prActionErrors[record.id] != nil || attention { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange) }
                else if record.snapshot.draft { Image(systemName: "doc.text").foregroundStyle(.secondary) }
                else if model.section(for: record) == .paused { Image(systemName: "pause.circle").foregroundStyle(.secondary) }
                else if model.section(for: record) == .queued { Image(systemName: "tray").foregroundStyle(.secondary) }
                else if model.section(for: record) == .ready { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                else { Image(systemName: "clock").foregroundStyle(.secondary) }
            }.font(.system(size: 12)).frame(width: 16, height: 17).padding(.top, 1)
            VStack(alignment: .leading, spacing: 5) {
                Text(record.displayTitle).font(.callout.weight(model.selectedNumber == record.id ? .medium : .regular))
                    .foregroundStyle(.primary).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 4) {
                    Text(record.numberLabel + (record.scope.map { " · \($0)" } ?? ""))
                    Spacer(minLength: 0)
                    if running { Text(model.prSpend(record)).monospacedDigit() }
                }.font(.caption).foregroundStyle(.secondary)
                if let progress = model.progressLabel(record.id) { Text(progress).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                else if model.prActionErrors[record.id] != nil { Text("Action failed · open to retry").font(.caption).foregroundStyle(.secondary) }
                else if let status = model.listStatus(record) { Text(status).font(.caption).foregroundStyle(.secondary).lineLimit(2).help(status) }
            }
        }.padding(.vertical, 7)
        .tag(record.id).listRowSeparator(.hidden)
            .contextMenu {
                Button("Open on GitHub") { model.track("open_pr", number: record.id); model.openGitHub(record.snapshot.url) }
                Button("Refresh GitHub") { Task { await model.recheck(record) } }.disabled(!model.canAct(on: record))
                if record.snapshot.draft && record.canMarkReady == true {
                    Button("Mark ready for review") { Task { await model.act("mark-ready", on: record) } }.disabled(!model.canAct(on: record))
                    Button(model.selectedDrafts.contains(record.id) ? "Remove from bulk selection" : "Select for bulk ready") {
                        model.selectingDrafts = true
                        model.selectDraft(record.id, selected: !model.selectedDrafts.contains(record.id))
                    }.disabled(model.promotingDrafts)
                } else if !record.snapshot.draft && record.canMarkReady == true {
                    Button("Convert to draft") { Task { await model.act("mark-draft", on: record) } }.disabled(!model.canAct(on: record))
                }
                if !record.snapshot.draft && record.isWatched { Button("Start task…") { model.startTask(record) } }
                Button("Request review…") { reviewer = ""; reviewTarget = record }.disabled(!model.canAct(on: record))
                Button("Request Stamphog approval") { Task { await model.act("request-approval", on: record) } }.disabled(!model.canRequestApproval(record)).help(record.approval?.reason ?? "Refresh this PR to check approval availability")
                Divider()
                Button("Copy PR link") { model.track("copy_pr_link", number: record.id); model.copy(record.snapshot.url) }
            }
    }
}
struct PRDetailView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var model: InboxModel
    @State private var showChecks: Bool
    @State private var showReview: Bool
    @State private var reviewer = ""
    @State private var requestingReviewer = false
    @FocusState private var answerFocused: Bool
    @State private var composerNumber: Int?
    init(model: InboxModel, initialTab: String = "agent") { self.model = model; _showChecks = State(initialValue: initialTab == "checks"); _showReview = State(initialValue: initialTab == "review") }
    var body: some View {
        if let record = model.selected {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header(record)
                    GitHubConnectionBanner(model: model)
                    if let error = model.error(for: record) { ErrorBanner(text: error, refresh: { Task { await model.recheck(record) } }) }
                    if record.sleepInterruptedAt != nil { Label("Paused while the Mac was asleep · checking the run", systemImage: "moon.zzz").font(.callout).foregroundStyle(.secondary) }
                    if let pending = record.pendingAnswer, pending.requiresConfirmation {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Your answer is saved").font(.headline)
                            Text("The PR or question changed. Check the current question before using this answer.").font(.callout)
                            FeedbackText(text: pending.text)
                            HStack {
                                Button("Use this answer") { Task { await model.act("confirm-reply", on: record) } }.disabled(!model.canAct(on: record) || record.decision.kind != "human")
                                Button("Edit answer") { model.drafts[record.id] = pending.text; answerFocused = true }
                                Button("Discard") { Task { await model.act("discard-reply", on: record) } }.disabled(!model.canAct(on: record))
                            }
                        }.padding(14).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    }
                    primaryActions(record)
                    if record.decision.kind != "human" { ApprovalRequestView(record: record, model: model) }
                    if record.decision.kind == "ready", let report = record.readiness {
                        Fold("Readiness report") {
                            VStack(alignment: .leading, spacing: 7) {
                                Text("Commit \(report.head.prefix(8))").font(.system(.caption, design: .monospaced))
                                Text("\(report.summary.passed) passed · \(report.summary.skipped) skipped · \(report.summary.open_threads) open \(report.summary.open_threads == 1 ? "thread" : "threads")").font(.callout)
                                Text("Approval: \(report.summary.approval?.lowercased().replacingOccurrences(of: "_", with: " ") ?? "not recorded")").font(.callout)
                                if let observed = report.observed_at { Text("Checked \(shortAge(observed)) ago").font(.caption).foregroundStyle(.secondary) }
                                ForEach(report.reasons, id: \.self) { Text($0).font(.callout).foregroundStyle(.secondary) }
                            }
                        }
                    }
                    if requestingReviewer { HStack { TextField("GitHub username or organization/team", text: $reviewer).textFieldStyle(.roundedBorder); Button("Request review") { Task { if await model.act("reviewer", on: record, reviewer: reviewer) { reviewer = ""; requestingReviewer = false } } }.disabled(!model.canAct(on: record) || reviewer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } }
                    if showChecks { CheckSummaryView(record: record, model: model) }
                    if showReview { ReviewThreadsView(record: record, model: model) }
                    if canCompose(record) {
                        if composerNumber == record.id || model.needsAnswer(record) && (record.decision.options?.isEmpty ?? true) || model.lastRun(record)?.prompt?.kind == "question" {
                            RunComposer(record: record, model: model, focus: $answerFocused)
                        } else if record.decision.kind != "human" {
                            Button("Give Woodshed instructions…") { openComposer(record) }.buttonStyle(.link).font(.callout)
                        }
                    }
                    if let run = model.lastRun(record), run.live { RunCard(run: run, record: record, model: model).id(run.id) }
                    if record.assessment?.report != nil || record.assessment?.result?.evidence.isEmpty == false || record.decision.kind == "human" && record.approval?.status == "approved" {
                        Fold("Investigation details") {
                            VStack(alignment: .leading, spacing: 12) {
                                if let report = record.assessment?.report, !report.isEmpty {
                                    Text("What the repair reported").font(.callout.weight(.medium))
                                    FeedbackText(text: report).font(.callout).foregroundStyle(.secondary)
                                }
                                ForEach(Array((record.assessment?.result?.evidence ?? []).enumerated()), id: \.offset) { _, item in
                                    Button(item.detail) { model.openExternal(item.url) }.buttonStyle(.link).font(.callout).multilineTextAlignment(.leading)
                                }
                                if record.decision.kind == "human" { ApprovalRequestView(record: record, model: model) }
                            }
                        }
                    }
                    let completed = model.runs(record).filter { !$0.live }
                    if !completed.isEmpty {
                        Fold("Run history (\(completed.count))") { RunHistoryView(runs: completed, model: model, showPR: false) }
                    }
                }.frame(maxWidth: 900, alignment: .topLeading).padding(24).frame(maxWidth: .infinity, alignment: .topLeading)
            }.frame(minWidth: 410, minHeight: 440).background(Color(nsColor: .windowBackgroundColor))
                .task(id: record.job?.name) {
                    await model.loadAgent()
                    if model.startTaskNumber == record.id {
                        await Task.yield()
                        composerNumber = record.id
                        answerFocused = true
                        model.startTaskNumber = nil
                    }
                }
                .onChange(of: model.startTaskNumber) { _, number in
                    if number == record.id { openComposer(record); model.startTaskNumber = nil }
                }
        } else { ContentUnavailableView("Choose a PR", systemImage: "hammer", description: Text("Your runs and decisions appear here.")) }
    }
    private func canCompose(_ record: PullRequestRecord) -> Bool {
        !record.snapshot.draft && record.isWatched && !record.paused && model.mode != .paused && record.job?.kind != "triage" && record.decision.kind != "ready" && record.recovery?.retryAt == nil
    }
    private func openComposer(_ record: PullRequestRecord) {
        composerNumber = record.id
        Task { await Task.yield(); answerFocused = true }
    }
    private func header(_ record: PullRequestRecord) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(record.displayTitle).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            HStack(spacing: 8) {
                Text(([record.numberLabel, record.scope].compactMap { $0 }).joined(separator: " · "))
                    .font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                Spacer(minLength: 8)
                Button { model.track("open_pr", number: record.id); model.openGitHub(record.snapshot.url) } label: { Image(systemName: "arrow.up.right.square") }
                    .help("Open on GitHub").accessibilityLabel("Open on GitHub")
                Button { Task { await model.recheck(record) } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(!model.canAct(on: record)).help("Refresh this PR (⌘R)").accessibilityLabel("Refresh this PR")
                Menu {
                    Button("Request review…") { requestingReviewer.toggle() }.disabled(!model.canAct(on: record))
                    Button("Request Stamphog approval") { Task { await model.act("request-approval", on: record) } }.disabled(!model.canRequestApproval(record)).help(record.approval?.reason ?? "Refresh this PR to check approval availability")
                    Button("Copy PR link") { model.track("copy_pr_link", number: record.id); model.copy(record.snapshot.url) }
                    Divider()
                    Button(record.isWatched ? "Stop watching" : "Watch PR") { Task { await model.act(record.isWatched ? "unwatch" : "watch", on: record) } }.disabled(!model.canAct(on: record))
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().help("More PR actions").accessibilityLabel("More PR actions")
            }.buttonStyle(.borderless)
            HStack(spacing: 8) {
                if let progress = model.progressLabel(record.id) {
                    ProgressView().controlSize(.small)
                    Text(progress).font(.callout).foregroundStyle(.secondary)
                } else {
                    Image(systemName: record.decision.kind == "human" ? "exclamationmark.circle" : model.section(for: record) == .paused ? "pause.circle" : record.snapshot.draft ? "doc.text" : model.lastRun(record)?.live == true ? "hammer" : record.decision.kind == "ready" ? "checkmark.circle" : "clock").foregroundStyle(record.decision.kind == "human" ? Color.orange : Color.secondary)
                    Text(model.lastRun(record)?.state == "preparing" ? "Preparing the PR checkout" : record.job != nil && model.lastRun(record)?.live == true ? record.job?.kind == "triage" ? "Checking GitHub" : "Running" : model.listStatus(record) ?? record.statusLabel).font(.callout).foregroundStyle(.secondary)
                }
                if let stack = record.snapshot.stack { Text("· \(stack.position) of \(stack.size) in stack").font(.callout).foregroundStyle(.secondary) }
            }
            HStack(spacing: 20) {
                Button { showChecks.toggle() } label: {
                    Label(record.checksLabel, systemImage: record.snapshot.checks.contains { $0.failed } ? "exclamationmark.circle" : "checkmark.circle")
                        .foregroundStyle(record.snapshot.checks.contains { $0.failed } ? Color.orange : Color.secondary)
                    Image(systemName: showChecks ? "chevron.up" : "chevron.down").font(.caption2)
                }.buttonStyle(.borderless).accessibilityValue(showChecks ? "Expanded" : "Collapsed")
                if !record.snapshot.threads.isEmpty || showReview { Button { showReview.toggle() } label: {
                    Label("\(record.snapshot.threads.count) open thread\(record.snapshot.threads.count == 1 ? "" : "s")", systemImage: "bubble.left")
                    Image(systemName: showReview ? "chevron.up" : "chevron.down").font(.caption2)
                }.buttonStyle(.borderless).foregroundStyle(.secondary).accessibilityValue(showReview ? "Expanded" : "Collapsed") }
            }.font(.callout)
        }.animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: model.pendingActions[record.id])
    }
    @ViewBuilder private func primaryActions(_ record: PullRequestRecord) -> some View {
        if record.snapshot.draft {
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                Text("Start maintaining this PR").font(.headline)
                Text(model.mode == .auto ? "Mark it ready for review. Woodshed will monitor CI and reviews, and queue repairs as needed." : model.mode == .paused ? "Mark it ready for review now. Maintenance will wait until you resume Woodshed." : "Mark it ready for review to start monitoring CI and reviews. You can request a repair when needed.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if record.canMarkReady == true {
                    Button { Task { await model.act("mark-ready", on: record) } } label: {
                        HStack(spacing: 8) {
                            if model.pendingActions[record.id] == "mark-ready" { ProgressView().controlSize(.small) }
                            Text(model.pendingActions[record.id] == "mark-ready" ? model.executingAction == record.id ? "Marking ready…" : "Queued…" : "Mark ready for review")
                        }
                    }.buttonStyle(.borderedProminent).controlSize(.large).disabled(!model.canAct(on: record))
                } else if record.canMarkReady == false {
                    Text("Only the PR author can mark this draft ready.").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.vertical, 8)
        } else if !record.isWatched {
            Button("Watch PR") { Task { await model.act("watch", on: record) } }.buttonStyle(.borderedProminent).disabled(!model.canAct(on: record))
        } else if record.paused {
            Button("Resume") { Task { await model.act("resume", on: record) } }.buttonStyle(.borderedProminent).disabled(!model.canAct(on: record))
        } else if model.mode == .paused {
            Button("Resume Auto") { Task { await model.updateSettings(["mode": "auto"]) } }.buttonStyle(.borderedProminent).disabled(!model.canSaveSettings)
        } else if record.decision.kind == "ready" {
            if record.readiness?.ready == false { Button("Refresh readiness") { Task { await model.recheck(record) } }.buttonStyle(.borderedProminent).disabled(!model.canAct(on: record)) }
            else { Button("Merge on GitHub") { model.track("merge_on_github", number: record.id); model.openGitHub(record.snapshot.url) }.buttonStyle(.borderedProminent) }
        } else if record.decision.kind == "human" {
            VStack(alignment: .leading, spacing: 10) {
                Text(record.decision.title ?? (model.needsAnswer(record) ? "Answer this question" : "The repair needs your help")).font(.headline)
                if let question = record.decision.question, question != record.decision.reason, !question.contains(record.decision.reason) { FeedbackText(text: record.decision.reason).font(.callout).foregroundStyle(.secondary) }
                Text(record.decision.question ?? record.decision.reason).font(.body).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if record.recovery != nil && record.decision.title == "Retry recovery" {
                    Button("Retry recovery") { Task { await model.recheck(record) } }.buttonStyle(.borderedProminent).disabled(!model.canAct(on: record))
                } else if model.lastRun(record)?.state == "budget" || record.decision.reason.localizedCaseInsensitiveContains("spend") || record.decision.title?.localizedCaseInsensitiveContains("budget") == true {
                    HStack {
                        if record.job != nil && model.lastRun(record)?.costUSD != nil && (model.state?.spend.map { $0.capUSD - $0.spentUSD >= 1 } ?? true) { Button("Allow $1.00 more for this run") { Task { await model.act("topup", on: record, amount: 1) } }.buttonStyle(.borderedProminent).disabled(!model.canAct(on: record)) }
                        else { Button("Spend settings") { model.showSettings("spend") }.buttonStyle(.borderedProminent) }
                        Button("Stop run") { Task { await model.act("stop", on: record) } }.disabled(!model.canAct(on: record))
                    }
                    Text("The daily cap stays unchanged.").font(.caption).foregroundStyle(.secondary)
                } else {
                    if let action = record.decision.action {
                        Button(action.label) { model.openExternal(action.url) }.buttonStyle(.borderedProminent)
                    }
                    if let options = record.decision.options, !options.isEmpty {
                        ForEach(options) { option in Button(option.label) { Task { await model.act("reply", on: record, message: option.value) } }.buttonStyle(.bordered).disabled(!model.canAct(on: record)) }
                        Button("Write a different answer…") { openComposer(record) }.buttonStyle(.link)
                    } else if record.decision.response == "recheck" {
                        Button("Recheck PR") { Task { await model.recheck(record) } }.buttonStyle(.bordered).disabled(!model.canAct(on: record))
                    } else if !model.needsAnswer(record) && model.lastRun(record)?.prompt?.kind != "question" {
                        Button("Retry with instructions…") { openComposer(record) }.buttonStyle(.bordered).disabled(!model.canAct(on: record))
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(14).background(.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}
struct ApprovalRequestView: View {
    let record: PullRequestRecord
    @ObservedObject var model: InboxModel
    var body: some View {
        if !record.snapshot.draft, record.snapshot.state == "OPEN", record.isWatched,
           let approval = record.approval, approval.head == record.snapshot.head {
            if approval.status == "available" || model.pendingActions[record.id] == "request-approval" {
                VStack(alignment: .leading, spacing: 6) {
                    Button { Task { await model.act("request-approval", on: record) } } label: {
                        HStack(spacing: 7) {
                            if model.pendingActions[record.id] == "request-approval" { ProgressView().controlSize(.small) }
                            Text(model.pendingActions[record.id] == "request-approval" ? model.executingAction == record.id ? "Requesting Stamphog approval…" : "Queued…" : "Request Stamphog approval")
                        }
                    }.buttonStyle(.borderedProminent).disabled(!model.canRequestApproval(record)).help(record.approval?.reason ?? "Refresh this PR to check approval availability")
                    Text(model.mode == .auto ? "Auto requests approval when this commit meets the prerequisites." : "Request AI approval for this commit.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else if approval.status == "approved" || approval.status == "requested" && record.decision.kind != "approval" {
                Label(approval.reason, systemImage: approval.status == "approved" ? "checkmark.circle" : "clock")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }
}
struct CheckSummaryView: View {
    let record: PullRequestRecord
    @ObservedObject var model: InboxModel
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            let outstanding = record.snapshot.checks.filter { $0.failed || $0.pending }
            if outstanding.isEmpty { Text("All reported checks have finished.").foregroundStyle(.secondary) }
            ForEach(Array(outstanding.enumerated()), id: \.offset) { _, check in
                HStack { Image(systemName: check.failed ? "exclamationmark.circle" : "clock").foregroundStyle(check.failed ? Color.orange : .secondary); Text(check.name).font(.callout).lineLimit(2); Spacer(); Text(check.label).font(.caption).foregroundStyle(.secondary); if !check.url.isEmpty { Button { model.openExternal(check.url) } label: { Image(systemName: "arrow.up.right") }.buttonStyle(.borderless) } }
            }
            Button("All checks on GitHub ↗") { model.openGitHub(record.snapshot.url + "/checks") }.buttonStyle(.link).font(.caption)
        }.padding(12).background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
    }
}
struct ReviewThreadsView: View {
    let record: PullRequestRecord
    @ObservedObject var model: InboxModel
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if record.snapshot.threads.isEmpty { Text("No unresolved threads.").foregroundStyle(.secondary) }
            ForEach(record.snapshot.threads) { thread in
                Fold(thread.comments.first?.author ?? "Review thread") {
                    VStack(alignment: .leading, spacing: 8) { ForEach(Array(thread.comments.enumerated()), id: \.offset) { _, comment in FeedbackText(text: comment.body).font(.callout) }; if let first = thread.comments.first { Button("Open thread ↗") { model.openGitHub(first.url) }.buttonStyle(.link) } }
                }
                Text(thread.comments.first?.body.split(separator: "\n").first.map(String.init) ?? "Open thread").font(.callout).lineLimit(2)
            }
        }.padding(12).background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
    }
}
struct RunCard: View {
    let run: AgentRun
    let record: PullRequestRecord
    @ObservedObject var model: InboxModel
    @State private var showOutput = false
    private var outputText: String {
        guard let agent = model.agent else { return "Loading run output…" }
        if !agent.output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return agent.output }
        if !agent.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return agent.message }
        return "No agent output yet. Checkout progress appears here before the agent starts."
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(run.state == "preparing" ? "Preparing checkout" : run.live ? record.job?.kind == "triage" ? "Investigation" : "Running" : "Last run").font(.headline)
                Spacer()
                if run.live { Button("Interrupt", role: .destructive) { Task { await model.act("interrupt", on: record) } }.buttonStyle(.borderless).disabled(!model.canAct(on: record)) }
            }
            Text("\(model.modelName(run.model)) · \(run.turns) turns" + (run.live ? "" : " · \(run.duration)") + " · \(run.spendLabel)").font(.caption).foregroundStyle(.secondary)
            if run.live {
                TimelineView(.periodic(from: .now, by: 30)) { _ in Text("Run started \(shortAge(run.startedAt)) ago").font(.caption).foregroundStyle(.secondary) }
                FeedbackText(text: run.summary).font(.callout).lineLimit(3)
            }
            Fold("Run details") { FeedbackText(text: run.prompt?.text ?? run.summary).font(.callout) }
            if let job = record.job {
                Fold("Session and output") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { if run.state != "preparing" { Button("Open run") { model.openAgent(job.name) }.buttonStyle(.link) }; Button(showOutput ? "Hide output" : "Show output") { showOutput.toggle(); model.agentOutputVisible = showOutput; if showOutput { Task { await model.loadAgent(force: true) } } }.buttonStyle(.link) }.font(.caption)
                        if showOutput {
                            if let error = model.agentError { ErrorBanner(text: error) }
                            ScrollViewReader { proxy in
                                ScrollView([.vertical, .horizontal]) {
                                    Text(verbatim: outputText).font(.system(.caption, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: true, vertical: true).padding(10).id("output")
                                }.frame(height: 170).onAppear { proxy.scrollTo("output", anchor: .bottomLeading) }.onChange(of: model.agent?.output) { _, _ in proxy.scrollTo("output", anchor: .bottomLeading) }
                            }.background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 7))
                        }
                    }
                }
            }
        }
    }
}
struct RunComposer: View {
    let record: PullRequestRecord
    @ObservedObject var model: InboxModel
    var focus: FocusState<Bool>.Binding
    @State private var selectedModel = ""
    private var draft: Binding<String> { Binding(get: { model.drafts[record.id] ?? "" }, set: { model.drafts[record.id] = $0 }) }
    private var isReply: Bool { model.needsAnswer(record) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                if draft.wrappedValue.isEmpty { Text(isReply ? "Your answer to the agent" : "Tell the agent what to do next").font(.body).foregroundStyle(.secondary).padding(.leading, 5).allowsHitTesting(false) }
                TextEditor(text: draft).focused(focus).scrollContentBackground(.hidden).frame(height: 76).font(.body).accessibilityLabel(isReply ? "Your answer" : "Run instructions")
            }
            HStack {
                if !isReply {
                    VStack(alignment: .leading, spacing: 2) {
                        Menu("Model options") {
                            Picker("Model", selection: $selectedModel) {
                                Text("Default · " + model.defaultModelName).tag("")
                                ForEach((model.state?.models ?? []).filter { $0.id != model.state?.settings?.defaultModel }) { Text($0.name).tag($0.id) }
                            }.pickerStyle(.inline)
                        }.menuStyle(.borderlessButton).fixedSize()
                        Text(selectedModel.isEmpty ? "Default · " + model.defaultModelName : model.modelName(selectedModel))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                if model.actionPending { ProgressView().controlSize(.small) }
                Button(isReply ? "Send reply" : record.decision.response == "retry" ? "Retry repair" : record.job == nil ? "Start repair" : "Restart with these instructions") {
                    Task { await model.sendDraft(record, isReply: isReply, model: selectedModel) }
                }.disabled(!model.canAct(on: record) || isReply && draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !isReply && (record.job != nil || record.decision.response == "retry") && draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.font(.callout)
            if record.pendingReply != nil { Text("Your reply is queued until a run slot is available.").font(.caption).foregroundStyle(.secondary) }
        }.padding(12).overlay(RoundedRectangle(cornerRadius: 9).stroke(.secondary.opacity(0.4)))
    }
}
struct RunHistoryView: View {
    let runs: [AgentRun]
    @ObservedObject var model: InboxModel
    let showPR: Bool
    var body: some View {
        if runs.isEmpty { ContentUnavailableView("No runs yet", systemImage: "hammer", description: Text("Completed runs will appear here. Waiting for CI doesn’t create a run.")) }
        else { LazyVStack(alignment: .leading, spacing: 18) { ForEach(runs) { run in VStack(alignment: .leading, spacing: 6) { HStack(alignment: .top) { if showPR { Button("#" + String(run.number)) { model.showMain(run.number) }.buttonStyle(.link) }; Text(run.summary).font(.callout).lineLimit(3); Spacer(); Text(shortAge(run.endedAt ?? run.startedAt)).font(.caption).foregroundStyle(.secondary) }; Text("\(model.modelName(run.model)) · \(run.turns) turns · \(run.duration) · \(run.spendLabel)").font(.caption).foregroundStyle(.secondary) }; Divider() } }.frame(maxWidth: .infinity, alignment: .topLeading) }
    }
}
struct ActivityView: View {
    @ObservedObject var model: InboxModel
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 18) { Text("All runs").font(.title2.weight(.semibold)); RunHistoryView(runs: model.allRuns, model: model, showPR: true) }.frame(maxWidth: .infinity, alignment: .topLeading).padding(20) }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(Color(nsColor: .windowBackgroundColor)) }
}
