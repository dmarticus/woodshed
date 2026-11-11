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
    private var quiet: Bool { model.attention.isEmpty && model.running.isEmpty && model.ready.isEmpty }
    var body: some View {
        VStack(spacing: 0) {
            MenuHeader(model: model)
            Divider()
            if !model.connected {
                VStack(spacing: 10) {
                    Image(systemName: "wifi.slash").font(.system(size: 22, weight: .light)).foregroundStyle(.secondary)
                    Text(model.connectionSummary).font(.callout).multilineTextAlignment(.center)
                    if let error = model.connectionError { Text(error).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(2) }
                    Button("Reconnect") { Task { await model.refresh() } }.buttonStyle(.borderedProminent).controlSize(.small)
                }.frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.vertical, 22)
            } else {
                ScrollView { list }.scrollBounceBehavior(.basedOnSize).frame(maxHeight: 460)
            }
            if !model.connected { Divider() }
            MenuFooter(model: model)
        }
        .frame(width: 340)
    }
    @ViewBuilder private var list: some View {
        VStack(spacing: 0) {
            if let message = model.githubConnectionIssue {
                MenuNotice(icon: "person.crop.circle.badge.exclamationmark", text: message, action: "Reconnect GitHub") { model.reconnectGitHub() }
            }
            ForEach(model.controllerWarnings) { MenuNotice(icon: "exclamationmark.triangle.fill", text: $0.message) }
            if model.notificationBroken {
                MenuNotice(icon: "bell.slash", text: "Notifications are off", action: "Open settings") { Task { await model.enableNotifications() } }
            }
            ForEach(model.attention) { record in
                MenuRow(title: record.displayTitle, detail: record.decision.title ?? record.decision.reason, number: record.id, accent: .orange) {
                    Circle().fill(.orange).frame(width: 8, height: 8).shadow(color: .orange.opacity(0.5), radius: 3, y: 1)
                } open: { model.showMain(record.id) }.contextMenu { prContextMenu(record) }
            }
            ForEach(model.running) { record in
                MenuRow(title: record.displayTitle, detail: model.listStatus(record) ?? "Working", number: record.id, trailing: model.prSpend(record)) {
                    ProgressView().controlSize(.mini)
                } open: { model.showMain(record.id) }.contextMenu { prContextMenu(record) }
            }
            ForEach(model.ready) { record in
                MenuRow(title: record.displayTitle, detail: "Ready to merge", number: record.id) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                } open: { model.showMain(record.id) }.contextMenu { prContextMenu(record) }
            }
            if quiet {
                VStack(spacing: 6) {
                    Image(systemName: "hammer").font(.system(size: 20, weight: .light)).foregroundStyle(.tertiary)
                    Text("All quiet in the woodshed").font(.callout.weight(.medium))
                    Text(model.mode == .paused ? "Paused. Nothing new will start." : "Nothing needs you right now.").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity).padding(.vertical, 18)
                if !(model.mergeQueuePRs.isEmpty && model.queued.isEmpty && model.waiting.isEmpty && model.pausedPRs.isEmpty && model.draftPRs.isEmpty) { MenuDivider() }
            }
            group("In merge queue", records: model.mergeQueuePRs, icon: "arrow.triangle.merge")
            group("Queued", records: model.queued, icon: "tray")
            group("Waiting", records: model.waiting, icon: "clock")
            group("Paused", records: model.pausedPRs, icon: "pause.circle")
            group("Drafts", records: model.draftPRs, icon: "doc.text")
        }
    }
    @ViewBuilder private func group(_ title: String, records: [PullRequestRecord], icon: String) -> some View {
        if !records.isEmpty {
            MenuGroup(title: title, count: records.count, icon: icon) {
                ForEach(records) { record in
                    Button { model.showMain(record.id) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(record.displayTitle).lineLimit(1)
                            if let status = model.listStatus(record) { Text(status).font(.caption).foregroundStyle(.secondary).lineLimit(1).help(status) }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 5).padding(.leading, 42).padding(.trailing, 14).contentShape(Rectangle())
                    }.buttonStyle(MenuRowStyle()).contextMenu { prContextMenu(record) }
                }
            }
        }
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
                if !model.mergeQueuePRs.isEmpty { Section("Merge queue") { ForEach(model.mergeQueuePRs) { sidebarRow($0) } } }
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
        .sheet(item: $reviewTarget) { record in
            ReviewRequestSheet(model: model, record: record)
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
                Button("Request review…") { reviewTarget = record }.disabled(!model.canChooseReviewer(record))
                Button("Request Stamphog approval") { Task { await model.act("request-approval", on: record) } }.disabled(!model.canRequestApproval(record)).help(record.approval?.reason ?? "Refresh this PR to check approval availability")
                Divider()
                Button("Copy PR link") { model.track("copy_pr_link", number: record.id); model.copy(record.snapshot.url) }
            }
    }
}
struct ReviewRequestSheet: View {
    @Environment(\.dismiss) private var dismiss
    @FocusState private var searchFocused: Bool
    @ObservedObject var model: InboxModel
    let record: PullRequestRecord
    @State private var query = ""
    @State private var selection: String?
    @State private var result: ReviewerSuggestions?
    @State private var loading = true
    @State private var loadError: String?
    @State private var requestError: String?
    @State private var reload = 0

    private var current: PullRequestRecord? {
        model.state?.prs.first { $0.id == record.id && $0.snapshot.head == record.snapshot.head && $0.snapshot.state == "OPEN" && !$0.snapshot.draft }
    }
    private var search: String {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
    }
    private var matches: [ReviewerSuggestions.Candidate] {
        (result?.suggestions ?? []).filter {
            search.isEmpty || $0.handle.localizedCaseInsensitiveContains(search) || $0.name?.localizedCaseInsensitiveContains(search) == true
        }
    }
    private var manualHandle: String? {
        guard search.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]{0,38}(/[A-Za-z0-9][A-Za-z0-9-]{0,99})?$"#, options: .regularExpression) != nil,
              !(result?.suggestions.contains { $0.handle.caseInsensitiveCompare(search) == .orderedSame } ?? false),
              !(result?.requested.contains { $0.caseInsensitiveCompare(search) == .orderedSame } ?? false)
        else { return nil }
        return search
    }
    private var recipient: String? {
        guard let selection else { return nil }
        return matches.contains { $0.handle == selection } || manualHandle == selection ? selection : nil
    }
    private var submitting: Bool { model.pendingActions[record.id] == "reviewer" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Request review").font(.headline)
                Text("\(record.numberLabel) · \(record.displayTitle)")
                    .font(.callout).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                TextField("Search people or teams", text: $query)
                    .focused($searchFocused)
                    .onChange(of: query) { _, _ in selection = nil; requestError = nil }
            }.disabled(submitting)
            List(selection: $selection) {
                let suggested = matches.filter { $0.source != "repository" }
                let teams = matches.filter { $0.source == "repository" }
                if !suggested.isEmpty {
                    Section("Suggested for this PR") { ForEach(suggested) { candidateRow($0) } }
                }
                if !teams.isEmpty {
                    Section("Repository teams") { ForEach(teams) { candidateRow($0) } }
                }
                if let manualHandle {
                    Label("Use @\(manualHandle)", systemImage: "plus.circle").tag(manualHandle)
                }
            }
            .listStyle(.inset)
            .frame(height: 270)
            .disabled(submitting)
            .overlay {
                if matches.isEmpty && manualHandle == nil {
                    if loading { ProgressView("Loading reviewers…").controlSize(.small) }
                    else {
                        let alreadyRequested = result?.requested.contains { $0.caseInsensitiveCompare(search) == .orderedSame } == true
                        Text(alreadyRequested ? "Review already requested" : search.isEmpty ? "Enter a GitHub username or organization/team." : "No matching reviewers")
                            .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding()
                    }
                }
            }
            if search.isEmpty, let requested = result?.requested, !requested.isEmpty {
                let handles = requested.map { "@\($0)" }.joined(separator: ", ")
                Label("Already requested · \(handles)", systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).help(handles)
            }
            if let loadError {
                HStack {
                    Text(loadError).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Retry") { reload += 1 }.buttonStyle(.link).disabled(submitting)
                }
            }
            if current == nil {
                Text("This PR changed. Refresh it and open Request review again.").font(.callout).foregroundStyle(.secondary)
            } else if let requestError {
                Text(requestError).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack(spacing: 10) {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(submitting)
                Button(submitting ? "Requesting…" : "Request review") {
                    guard let current, let recipient else { return }
                    Task {
                        requestError = nil
                        if await model.act("reviewer", on: current, reviewer: recipient) { dismiss() }
                        else { requestError = model.prActionErrors[record.id] }
                    }
                }.keyboardShortcut(.defaultAction)
                    .disabled(model.preview || recipient == nil || current.map { !model.canAct(on: $0) } != false)
            }
        }
        .padding(20)
        .frame(minWidth: 440, idealWidth: 460)
        .interactiveDismissDisabled(submitting)
        .onAppear { searchFocused = true }
        .task(id: reload) {
            loading = true
            loadError = nil
            defer { loading = false }
            do {
                let response = try await model.reviewerSuggestions(for: record)
                guard !Task.isCancelled else { return }
                result = response
                if response.partial { loadError = "Some GitHub suggestions couldn’t be loaded." }
            } catch {
                if !Task.isCancelled { loadError = "Couldn’t load suggestions. You can enter a GitHub handle." }
            }
        }
    }

    private func candidateRow(_ candidate: ReviewerSuggestions.Candidate) -> some View {
        HStack(spacing: 10) {
            Image(systemName: candidate.kind == "team" ? "person.2" : "person")
                .frame(width: 20).foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.name ?? candidate.handle).lineLimit(1)
                if candidate.name != nil { Text("@\(candidate.handle)").font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 8)
            if candidate.source == "code_owner" { Text("Code owner").font(.caption).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 3)
        .tag(candidate.handle)
    }
}

struct PRDetailView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var model: InboxModel
    @State private var showChecks: Bool
    @State private var showReview: Bool
    @State private var reviewTarget: PullRequestRecord?
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
                    MergeQueueControls(record: record, model: model, repair: { openComposer(record) })
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
                    if showChecks { CheckSummaryView(record: record, model: model) }
                    if showReview { ReviewThreadsView(record: record, model: model) }
                    if canCompose(record) && record.mergeQueue?.active != true {
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
                .sheet(item: $reviewTarget) { target in
                    ReviewRequestSheet(model: model, record: target)
                }
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
                    Button("Request review…") { reviewTarget = record }.disabled(!model.canChooseReviewer(record))
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
        } else if record.mergeQueue?.active == true || record.mergeQueue?.needsAttention == true {
            EmptyView()
        } else if record.paused {
            Button("Resume") { Task { await model.act("resume", on: record) } }.buttonStyle(.borderedProminent).disabled(!model.canAct(on: record))
        } else if model.mode == .paused {
            Button("Resume Auto") { Task { await model.updateSettings(["mode": "auto"]) } }.buttonStyle(.borderedProminent).disabled(!model.canSaveSettings)
        } else if record.decision.kind == "ready" {
            if record.mergeQueue == nil && record.readiness?.ready == false { Button("Refresh readiness") { Task { await model.recheck(record) } }.buttonStyle(.borderedProminent).disabled(!model.canAct(on: record)) }
            else if record.mergeQueue == nil { Button("Merge on GitHub") { model.track("merge_on_github", number: record.id); model.openGitHub(record.snapshot.url) }.buttonStyle(.borderedProminent) }
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
struct MergeQueueControls: View {
    let record: PullRequestRecord
    @ObservedObject var model: InboxModel
    let repair: () -> Void
    var body: some View {
        if let queue = record.mergeQueue {
            if queue.active {
                VStack(alignment: .leading, spacing: 10) {
                    Label("In Trunk merge queue", systemImage: "arrow.triangle.merge").font(.headline)
                    Text(queue.status).font(.callout)
                    if queue.state == "pending_failure" { Text("Trunk may restart testing if an earlier PR caused the failure. No action needed yet.").font(.callout).foregroundStyle(.secondary) }
                    if let error = queue.error { Text(error).font(.callout).foregroundStyle(.secondary) }
                    Button("View queue status") { model.openGitHub(queue.url) }.buttonStyle(.link)
                    if let request = queue.submission?.url { Button("View submission on GitHub") { model.openGitHub(request) }.buttonStyle(.link).font(.caption) }
                }.padding(.vertical, 8)
            } else if queue.needsAttention || record.mergeQueueSubmission?.canSubmit == true || record.decision.kind == "ready" {
                VStack(alignment: .leading, spacing: 10) {
                    if queue.needsAttention {
                        Text("Removed from the merge queue").font(.headline)
                        Text(record.decision.reason).font(.callout).fixedSize(horizontal: false, vertical: true)
                        Button("Open queue failure") { model.openGitHub(queue.url) }.buttonStyle(.link)
                        if let detail = queue.terminal?.reason { Fold("Queue failure details") { FeedbackText(text: detail).font(.callout) } }
                    }
                    if let submission = record.mergeQueueSubmission {
                        if submission.scope.count > 1 { Text("Includes " + submission.scope.map { "#" + String($0) }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary) }
                        Button {
                            Task { await model.act("submit-merge-queue", on: record) }
                        } label: {
                            HStack(spacing: 8) {
                                if model.pendingActions[record.id] == "submit-merge-queue" { ProgressView().controlSize(.small) }
                                Text(model.pendingActions[record.id] == "submit-merge-queue" ? "Submitting…" : submission.label)
                            }
                        }.buttonStyle(.borderedProminent).disabled(!submission.canSubmit || !model.canAct(on: record) || model.mode == .paused)
                        if !submission.canSubmit, let reason = submission.reason { Text(reason).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    }
                    if queue.needsAttention {
                        HStack {
                            Button("Repair with instructions…", action: repair).disabled(!model.canAct(on: record))
                            Button("Dismiss alert") { Task { await model.act("dismiss-queue-alert", on: record) } }.buttonStyle(.link).disabled(!model.canAct(on: record))
                        }
                    }
                }.padding(.vertical, 8)
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

/// Gifox-style toolbar: window shortcuts on the left, the title centered, the run mode as three toggles on the right.
private struct MenuHeader: View {
    @ObservedObject var model: InboxModel
    var body: some View {
        ZStack {
            Text("Woodshed").font(.headline)
            HStack(spacing: 2) {
                MenuIconButton(symbol: "macwindow", help: "Open Woodshed (⌘O)") { model.showMain() }.keyboardShortcut("o")
                MenuIconButton(symbol: "gearshape", help: "Settings (⌘,)") { model.showSettings() }.keyboardShortcut(",")
                Spacer()
                if model.connected {
                    let current = model.pendingMode ?? model.mode
                    ForEach(Mode.allCases) { mode in
                        MenuIconButton(symbol: mode.symbol, help: mode.explanation, selected: current == mode) { model.setMode(mode) }
                            .disabled(!model.canSaveSettings || model.pendingMode != nil)
                            .accessibilityLabel(mode.label).accessibilityAddTraits(current == mode ? .isSelected : [])
                    }
                } else {
                    Label("Offline", systemImage: "wifi.slash").font(.caption).foregroundStyle(.secondary).padding(.trailing, 6)
                }
            }
        }.padding(.horizontal, 8).padding(.vertical, 7)
    }
}
private struct MenuFooter: View {
    @ObservedObject var model: InboxModel
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "dollarsign.circle").foregroundStyle(.secondary)
            Text(model.spendFooter.replacingOccurrences(of: "Est. today ", with: "")).font(.caption).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                .help(model.spendFooter)
            Spacer()
            Menu {
                Button("Open Woodshed") { model.showMain() }
                Button("Activity") { model.showActivity() }
                Button("Settings…") { model.showSettings() }
                Divider()
                Button("Quit Woodshed") { NSApplication.shared.terminate(nil) }
            } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("More")
            Button("") { NSApplication.shared.terminate(nil) }.keyboardShortcut("q").opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
        }.padding(.horizontal, 14).padding(.vertical, 9).opacity(model.connected ? 1 : 0.5)
    }
}
private struct MenuIconButton: View {
    let symbol: String
    let help: String
    var selected = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 14, weight: selected ? .semibold : .regular)).frame(width: 28, height: 24)
                .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                .background(selected ? Color.accentColor.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }.buttonStyle(MenuIconStyle()).help(help)
    }
}
private struct MenuIconStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Hovering { hovered in configuration.label.background(hovered ? Color.primary.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 6)).opacity(configuration.isPressed ? 0.6 : 1) } }
}
private struct MenuRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Hovering { hovered in configuration.label.background(Color.primary.opacity(configuration.isPressed ? 0.1 : hovered ? 0.06 : 0)) } }
}
private struct Hovering<Content: View>: View {
    @State private var hovered = false
    let content: (Bool) -> Content
    var body: some View { content(hovered).onHover { hovered = $0 } }
}
private struct MenuDivider: View { var body: some View { Divider() } }
private struct MenuRow<Glyph: View>: View {
    let title: String
    let detail: String
    let number: Int
    var accent: Color? = nil
    var trailing: String? = nil
    @ViewBuilder let glyph: Glyph
    let open: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            Button(action: open) {
                HStack(alignment: .center, spacing: 12) {
                    glyph.frame(width: 16)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title).font(.body.weight(.medium)).lineLimit(1)
                        HStack(spacing: 6) {
                            Text(detail).lineLimit(1).foregroundStyle(accent ?? .secondary)
                            Text("#\(String(number))").foregroundStyle(.tertiary).monospacedDigit()
                        }.font(.caption)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if let trailing { Text(trailing).font(.caption).foregroundStyle(.secondary).monospacedDigit() }
                }.padding(.horizontal, 14).padding(.vertical, 10).contentShape(Rectangle())
            }.buttonStyle(MenuRowStyle()).help(detail)
            MenuDivider()
        }
    }
}
private struct MenuNotice: View {
    let icon: String
    let text: String
    var action: String? = nil
    var perform: (() -> Void)? = nil
    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon).foregroundStyle(.orange).frame(width: 16).padding(.top, 1)
                VStack(alignment: .leading, spacing: 6) {
                    Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
                    if let action, let perform { Button(action, action: perform).controlSize(.small) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.horizontal, 14).padding(.vertical, 10).background(Color.orange.opacity(0.08))
            Divider()
        }
    }
}
private struct MenuGroup<Content: View>: View {
    let title: String
    let count: Int
    let icon: String
    @ViewBuilder let content: Content
    @State private var expanded = false
    var body: some View {
        VStack(spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.18)) { expanded.toggle() } } label: {
                HStack(spacing: 12) {
                    Image(systemName: icon).foregroundStyle(.secondary).frame(width: 16)
                    Text(title).frame(maxWidth: .infinity, alignment: .leading)
                    Text(String(count)).font(.callout).foregroundStyle(.secondary).monospacedDigit()
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary).rotationEffect(.degrees(expanded ? 90 : 0))
                }.padding(.horizontal, 14).padding(.vertical, 9).contentShape(Rectangle())
            }.buttonStyle(MenuRowStyle()).accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded { VStack(spacing: 0) { content }.padding(.bottom, 6) }
            MenuDivider()
        }
    }
}
extension Mode {
    var symbol: String { switch self { case .watch: "eye"; case .auto: "hammer"; case .paused: "pause.circle" } }
    var explanation: String {
        switch self {
        case .watch: "Watch: track PRs and report, without starting repairs"
        case .auto: "Auto: start repairs on its own"
        case .paused: "Paused: let running repairs finish, start nothing new"
        }
    }
}

struct WoodshedStatusIcon: View {
    @ObservedObject var model: InboxModel
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Image(systemName: !model.connected ? "wifi.slash" : model.mode == .paused ? "pause.circle" : model.mode == .auto ? "hammer.fill" : "hammer").font(.system(size: 15))
                .symbolEffect(.pulse, options: .repeating, isActive: model.connected && !model.running.isEmpty)
            if model.attentionCount > 0 { Circle().fill(.orange).frame(width: 6, height: 6).offset(x: 3, y: -2) }
        }.frame(width: 22, height: 18).accessibilityLabel("Woodshed, \(model.mode.label), \(model.attentionCount) need you")
    }
}
