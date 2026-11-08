// ClaudeNotch : l'état des sessions Claude Code dans l'encoche du Mac.
//
// Deux sources, fusionnées par identifiant de session :
// - les fichiers du mod notch-status (~/.claude/notch/sessions/<id>.json) :
//   l'état en direct, en cours ou en attente de ta réponse ;
// - les fiches de session de l'app Claude
//   (~/Library/Application Support/Claude/claude-code-sessions/…/local_*.json) :
//   le titre, le lien vers la session et le résumé du dernier tour (bloquée,
//   à relire, terminée), y compris pour les sessions qui ne tournent plus.
//
// Fermée, l'encoche montre l'étincelle Claude (animée quand une session
// travaille) et un badge ; survolée, elle se déplie sur la liste.

import AppKit
import SwiftUI

// MARK: - Couleurs et mesures

let claudeOrange = Color(red: 0.851, green: 0.467, blue: 0.341)
let waitingAmber = Color(red: 1.0, green: 0.72, blue: 0.25)
let doneGreen = Color(red: 0.30, green: 0.82, blue: 0.45)
let errorRed = Color(red: 1.0, green: 0.38, blue: 0.35)

enum Layout {
    static let earWidth: CGFloat = 30
    static let flare: CGFloat = 6
    static let expandedWidth: CGFloat = 460
    static let panelSize = CGSize(width: 540, height: 760)
    static let maxListHeight: CGFloat = 600
    static let maxWaiting = 8
    static let maxFinished = 6
}

enum Timing {
    static let minute: Double = 60_000
    static let day: Double = 86_400_000
    /// Sans battement de cœur du mod depuis 2 min, l'état en direct est périmé.
    static let liveStaleAfter = 2 * minute
    static let liveDeleteAfter = 60 * minute
    /// Une session de l'app sans activité depuis 15 min n'est plus en cours.
    static let turnStaleAfter = 15 * minute
    static let finishedShownFor = day
    static let recordsReadFor = 30 * day
}

let claudeAppBundleId = "com.anthropic.claudefordesktop"

// MARK: - Source 1 : fichiers du mod

enum LiveStatus: String, Decodable {
    case working, waiting, done, error, ended
}

struct LiveSession: Decodable {
    let id: String
    let status: LiveStatus
    let title: String?
    let project: String?
    let branch: String?
    let hostBundleId: String?
    let hostName: String?
    let surface: String?
    let lastPrompt: String?
    let lastAnswer: String?
    let waitingFor: String?
    let statusSince: Double
    let updatedAt: Double
}

// MARK: - Source 2 : fiches de session de l'app Claude

struct DesktopRecord: Decodable {
    struct Summary: Decodable {
        let category: String?
        let needsAction: String?

        enum CodingKeys: String, CodingKey {
            case category = "status_category"
            case needsAction = "needs_action"
        }
    }

    struct WrapUp: Decodable {
        let description: String?
    }

    let sessionId: String
    let cliSessionId: String?
    let title: String?
    let cwd: String?
    let isArchived: Bool?
    let lastActivityAt: Double?
    let lastTurnEdgeAt: Double?
    let latestUserFrameAt: Double?
    let postTurnSummary: Summary?
    let postTurnSummaryFor: String?
    let lastAssistantUuid: String?
    let turnWrapUp: WrapUp?

    /// Le résumé, seulement s'il porte sur la dernière réponse de Claude.
    var currentSummary: Summary? {
        guard let postTurnSummaryFor, postTurnSummaryFor == lastAssistantUuid else { return nil }
        return postTurnSummary
    }

    /// Pendant un tour, le dernier bord de tour est ton dernier message ;
    /// une fois le tour fini, le bord (la fin) vient après ce message.
    func isInTurn(now: Double) -> Bool {
        guard let user = latestUserFrameAt, let edge = lastTurnEdgeAt, let activity = lastActivityAt else { return false }
        return edge - user <= 250 && now - activity < Timing.turnStaleAfter
    }
}

// MARK: - Ce que l'encoche affiche

enum ItemStatus {
    case working, waiting, review, done, error

    var isWaiting: Bool { self == .waiting || self == .review }
    var isFinished: Bool { self == .done || self == .error }
}

struct SessionItem: Identifiable, Equatable {
    let id: String
    let status: ItemStatus
    let title: String
    let detail: String
    let project: String?
    let branch: String?
    let hostBundleIds: [String]
    /// L'identifiant `local_…` d'une session de l'app Claude, pour l'ouvrir.
    let desktopId: String?
    let since: Double
}

enum SessionMerger {
    static let terminalBundleIds = [
        "Apple_Terminal": "com.apple.Terminal",
        "iTerm.app": "com.googlecode.iterm2",
        "vscode": "com.microsoft.VSCode",
        "ghostty": "com.mitchellh.ghostty",
        "WarpTerminal": "dev.warp.Warp-Stable",
        "zed": "dev.zed.Zed",
    ]

    static func items(live: [LiveSession], desktop: [DesktopRecord], now: Double) -> [SessionItem] {
        var liveById: [String: LiveSession] = [:]
        for session in live { liveById[session.id] = session }
        var matched = Set<String>()
        var result: [SessionItem] = []
        for record in desktop where record.isArchived != true {
            let session = record.cliSessionId.flatMap { liveById[$0] }
            if let session { matched.insert(session.id) }
            if let item = item(record: record, live: session, now: now) { result.append(item) }
        }
        for session in live where !matched.contains(session.id) {
            if let item = item(live: session, now: now) { result.append(item) }
        }
        return result.sorted { $0.since > $1.since }
    }

    /// Une session de l'app Claude, avec son état en direct si le mod y tourne.
    private static func item(record: DesktopRecord, live: LiveSession?, now: Double) -> SessionItem? {
        let title = nonEmpty(record.title) ?? nonEmpty(live?.title) ?? "Nouvelle session"
        let edge = record.lastTurnEdgeAt ?? record.lastActivityAt ?? 0
        func make(_ status: ItemStatus, _ detail: String, _ since: Double) -> SessionItem {
            SessionItem(id: record.sessionId, status: status, title: title, detail: detail,
                        project: live?.project ?? project(fromCwd: record.cwd), branch: live?.branch,
                        hostBundleIds: [claudeAppBundleId], desktopId: record.sessionId, since: since)
        }

        if let live, live.status == .working || live.status == .waiting {
            return make(live.status == .working ? .working : .waiting, liveDetail(live, title: title), live.statusSince)
        }
        if live == nil, record.isInTurn(now: now) {
            return make(.working, "Claude travaille…", record.latestUserFrameAt ?? edge)
        }
        let summary = record.currentSummary
        switch summary?.category {
        case "blocked":
            return make(.waiting, nonEmpty(summary?.needsAction) ?? "Attend ta réponse", edge)
        case "review_ready":
            return make(.review, nonEmpty(summary?.needsAction) ?? "Prêt à relire", edge)
        default:
            guard now - (record.lastActivityAt ?? edge) < Timing.finishedShownFor else { return nil }
            let detail = nonEmpty(record.turnWrapUp?.description) ?? nonEmpty(live?.lastAnswer) ?? "Terminée"
            return make(live?.status == .error ? .error : .done, detail, max(edge, live?.statusSince ?? 0))
        }
    }

    /// Une session que seul le mod connaît (terminal, VS Code…).
    private static func item(live: LiveSession, now: Double) -> SessionItem? {
        let status: ItemStatus
        switch live.status {
        case .working: status = .working
        case .waiting: status = .waiting
        case .done: status = .done
        case .error: status = .error
        case .ended: return nil
        }
        if status.isFinished, now - live.statusSince > Timing.finishedShownFor { return nil }
        var hosts: [String] = []
        if let id = nonEmpty(live.hostBundleId) { hosts.append(id) }
        if live.surface == "desktop" { hosts.append(claudeAppBundleId) }
        if let id = live.hostName.flatMap({ terminalBundleIds[$0] }) { hosts.append(id) }
        let title = nonEmpty(live.title) ?? "Nouvelle session"
        return SessionItem(id: live.id, status: status, title: title, detail: liveDetail(live, title: title),
                           project: live.project, branch: live.branch, hostBundleIds: hosts,
                           desktopId: nil, since: live.statusSince)
    }

    private static func liveDetail(_ live: LiveSession, title: String) -> String {
        switch live.status {
        case .waiting:
            return nonEmpty(live.waitingFor) ?? "Attend ton accord"
        case .working:
            if let prompt = nonEmpty(live.lastPrompt), prompt != title { return "↳ \(prompt)" }
            return "Claude travaille…"
        case .done:
            return nonEmpty(live.lastAnswer) ?? "Terminée"
        case .error:
            return "Le tour s'est arrêté sur une erreur"
        case .ended:
            return ""
        }
    }

    static func project(fromCwd cwd: String?) -> String? {
        guard let cwd, !cwd.isEmpty else { return nil }
        if cwd.contains("/scratch-workspaces/") { return "Sans dossier" }
        return URL(fileURLWithPath: cwd).lastPathComponent
    }

    static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        return text
    }
}

// MARK: - Lecture des deux sources (hors du fil principal)

final class SessionScanner {
    private let files = FileManager.default
    private let decoder = JSONDecoder()
    private let liveDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/notch/sessions", isDirectory: true)
    private let desktopRoot = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Claude/claude-code-sessions", isDirectory: true)
    /// Une fiche n'est relue que si sa date de modification a changé.
    private var cache: [String: (modified: Date, record: DesktopRecord?)] = [:]

    private var tick = 0
    private var lastDesktop: [DesktopRecord] = []

    /// Les fichiers du mod chaque seconde, les fiches de l'app toutes les 3 s.
    func scan() -> [SessionItem] {
        let now = Date().timeIntervalSince1970 * 1000
        if tick % 3 == 0 { lastDesktop = scanDesktop(now: now) }
        tick += 1
        return SessionMerger.items(live: scanLive(now: now), desktop: lastDesktop, now: now)
    }

    private func scanLive(now: Double) -> [LiveSession] {
        let urls = (try? files.contentsOfDirectory(at: liveDirectory, includingPropertiesForKeys: nil)) ?? []
        var found: [LiveSession] = []
        for url in urls where url.pathExtension == "json" {
            // Un fichier en cours d'écriture ne se décode pas : il sera relu dans 1 s.
            guard let data = try? Data(contentsOf: url),
                  let session = try? decoder.decode(LiveSession.self, from: data) else { continue }
            let age = now - session.updatedAt
            if session.status == .ended || age > Timing.liveDeleteAfter {
                try? files.removeItem(at: url)
                continue
            }
            if age <= Timing.liveStaleAfter { found.append(session) }
        }
        return found
    }

    private func scanDesktop(now: Double) -> [DesktopRecord] {
        let cutoff = Date(timeIntervalSince1970: (now - Timing.recordsReadFor) / 1000)
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        var records: [DesktopRecord] = []
        var seen = Set<String>()
        for organization in children(of: desktopRoot) {
            for account in children(of: organization) {
                let urls = (try? files.contentsOfDirectory(at: account, includingPropertiesForKeys: keys)) ?? []
                for url in urls where url.lastPathComponent.hasPrefix("local_") && url.pathExtension == "json" {
                    guard let modified = try? url.resourceValues(forKeys: Set(keys)).contentModificationDate,
                          modified > cutoff else { continue }
                    seen.insert(url.path)
                    if let cached = cache[url.path], cached.modified == modified {
                        if let record = cached.record { records.append(record) }
                        continue
                    }
                    let record = (try? Data(contentsOf: url)).flatMap { try? decoder.decode(DesktopRecord.self, from: $0) }
                    cache[url.path] = (modified, record)
                    if let record { records.append(record) }
                }
            }
        }
        cache = cache.filter { seen.contains($0.key) }
        return records
    }

    private func children(of directory: URL) -> [URL] {
        let urls = (try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return urls.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
    }
}

@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var items: [SessionItem] = []
    @Published private(set) var lastSeen: Double = Date().timeIntervalSince1970 * 1000

    private let scanner = SessionScanner()
    private let queue = DispatchQueue(label: "claude-notch.scan", qos: .utility)
    private var isScanning = false
    private var timer: Timer?

    var allWaiting: [SessionItem] { items.filter { $0.status.isWaiting } }
    var waiting: [SessionItem] { Array(allWaiting.prefix(Layout.maxWaiting)) }
    var working: [SessionItem] { items.filter { $0.status == .working } }
    var finished: [SessionItem] { Array(items.filter { $0.status.isFinished }.prefix(Layout.maxFinished)) }
    var unseenFinished: Int { items.filter(isUnseen).count }
    /// Quelque chose à signaler fermé : l'icône et le badge s'affichent.
    var hasActivity: Bool { !allWaiting.isEmpty || !working.isEmpty || unseenFinished > 0 }
    /// Une session t'attend depuis moins de 10 min.
    var hasFreshWaiting: Bool {
        let now = Date().timeIntervalSince1970 * 1000
        return allWaiting.contains { now - $0.since < 10 * Timing.minute }
    }

    func isUnseen(_ item: SessionItem) -> Bool {
        item.status.isFinished && item.since > lastSeen
    }

    func markSeen() {
        lastSeen = Date().timeIntervalSince1970 * 1000
    }

    func start() {
        reload()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
        }
    }

    private func reload() {
        guard !isScanning else { return }
        isScanning = true
        let scanner = scanner
        queue.async {
            let found = scanner.scan()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.isScanning = false
                    if found != self.items { self.items = found }
                }
            }
        }
    }
}

// MARK: - Textes

@MainActor
enum AppNames {
    private static var cache: [String: String] = [:]

    static func name(for bundleId: String) -> String? {
        if let cached = cache[bundleId] { return cached }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return nil }
        let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        cache[bundleId] = name
        return name
    }
}

enum TimeText {
    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "fr_FR")
        formatter.unitsStyle = .short
        return formatter
    }()

    static func seconds(since ms: Double) -> Double {
        max(0, Date().timeIntervalSince1970 - ms / 1000)
    }

    static func ago(_ ms: Double) -> String {
        let elapsed = seconds(since: ms)
        return elapsed < 45 ? "à l'instant" : relative.localizedString(fromTimeInterval: -elapsed)
    }

    static func since(_ ms: Double) -> String {
        let minutes = Int(seconds(since: ms) / 60)
        if minutes < 1 { return "depuis moins d'1 min" }
        if minutes < 60 { return "depuis \(minutes) min" }
        return "depuis \(minutes / 60) h \(String(format: "%02d", minutes % 60))"
    }
}

// MARK: - Géométrie de l'encoche

struct NotchMetrics {
    let screenFrame: CGRect
    let notchSize: CGSize

    @MainActor
    static func current() -> NotchMetrics? {
        if let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }),
           let left = screen.auxiliaryTopLeftArea,
           let right = screen.auxiliaryTopRightArea {
            let width = screen.frame.width - left.width - right.width
            return NotchMetrics(screenFrame: screen.frame,
                                notchSize: CGSize(width: width, height: screen.safeAreaInsets.top))
        }
        // Écran sans encoche : une fausse encoche au centre de la barre des menus.
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return nil }
        let height = max(NSStatusBar.system.thickness, screen.frame.maxY - screen.visibleFrame.maxY)
        return NotchMetrics(screenFrame: screen.frame, notchSize: CGSize(width: 180, height: height))
    }
}

@MainActor
final class NotchUI: ObservableObject {
    @Published var expanded = false
    @Published var notchSize = CGSize(width: 185, height: 32)
    var contentSize: CGSize = .zero
}

// MARK: - Formes

/// Haut plat collé au bord de l'écran, petits évasements en haut, coins arrondis en bas.
struct NotchShape: Shape {
    var flare: CGFloat
    var bottomRadius: CGFloat

    var animatableData: CGFloat {
        get { bottomRadius }
        set { bottomRadius = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let radius = min(bottomRadius, (rect.height - flare) / 2, (rect.width - 2 * flare) / 2)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.minX + flare, y: rect.minY + flare),
                          control: CGPoint(x: rect.minX + flare, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX + flare, y: rect.maxY - radius))
        path.addQuadCurve(to: CGPoint(x: rect.minX + flare + radius, y: rect.maxY),
                          control: CGPoint(x: rect.minX + flare, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX - flare - radius, y: rect.maxY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - flare, y: rect.maxY - radius),
                          control: CGPoint(x: rect.maxX - flare, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX - flare, y: rect.minY + flare))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY),
                          control: CGPoint(x: rect.maxX - flare, y: rect.minY))
        path.closeSubpath()
        return path
    }
}

/// L'étincelle : des rayons arrondis de longueurs inégales autour d'un centre.
struct SparkShape: Shape {
    private static let lengths: [CGFloat] = [1, 0.8, 0.94, 0.76, 0.98, 0.84, 0.9, 0.78, 1, 0.82, 0.92, 0.8]

    func path(in rect: CGRect) -> Path {
        let radius = min(rect.width, rect.height) / 2
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let width = radius * 0.2
        let inner = radius * 0.12
        var path = Path()
        for (index, length) in Self.lengths.enumerated() {
            let angle = CGFloat(index) / CGFloat(Self.lengths.count) * 2 * .pi
            let ray = CGRect(x: -width / 2, y: -radius * length, width: width, height: radius * length - inner)
            let transform = CGAffineTransform(translationX: center.x, y: center.y).rotated(by: angle)
            path.addPath(Path(roundedRect: ray, cornerRadius: width / 2), transform: transform)
        }
        return path
    }
}

// Les animations passent par Core Animation : elles tournent dans le serveur
// de rendu, sans réveiller l'app ni remettre le panneau en page à chaque image.

/// Une vue à calque dont la forme ne bouge pas ; seules ses animations tournent.
class LayerShapeView: NSView {
    let shape = CAShapeLayer()
    let side: CGFloat

    init(side: CGFloat) {
        self.side = side
        super.init(frame: CGRect(x: 0, y: 0, width: side, height: side))
        wantsLayer = true
        shape.frame = bounds
        shape.contentsScale = 2
        layer?.addSublayer(shape)
    }

    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize { NSSize(width: side, height: side) }
}

final class SparkView: LayerShapeView {
    init(size: CGFloat) {
        super.init(side: size)
        shape.path = SparkShape().path(in: bounds).cgPath
        shape.fillColor = NSColor(claudeOrange).cgColor
    }

    required init?(coder: NSCoder) { nil }

    func setActive(_ isActive: Bool) {
        shape.opacity = isActive ? 1 : 0.8
        if isActive, shape.animation(forKey: "spin") == nil {
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = -2 * Double.pi
            spin.duration = 5
            spin.repeatCount = .infinity
            shape.add(spin, forKey: "spin")
        } else if !isActive {
            shape.removeAnimation(forKey: "spin")
        }
    }
}

final class RingView: LayerShapeView {
    init(diameter: CGFloat) {
        super.init(side: diameter)
        shape.path = CGPath(ellipseIn: bounds.insetBy(dx: 0.75, dy: 0.75), transform: nil)
        shape.fillColor = nil
        shape.strokeColor = NSColor(waitingAmber).cgColor
        shape.lineWidth = 1.5
        shape.opacity = 0
    }

    required init?(coder: NSCoder) { nil }

    func setPulsing(_ isPulsing: Bool) {
        if isPulsing, shape.animation(forKey: "pulse") == nil {
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 1
            grow.toValue = 1.6
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1
            fade.toValue = 0
            let pulse = CAAnimationGroup()
            pulse.animations = [grow, fade]
            pulse.duration = 1.4
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeOut)
            shape.add(pulse, forKey: "pulse")
        } else if !isPulsing {
            shape.removeAnimation(forKey: "pulse")
        }
    }
}

/// L'étincelle Claude, qui tourne quand une session travaille.
struct ClaudeSpark: NSViewRepresentable {
    var isActive: Bool
    var size: CGFloat

    func makeNSView(context: Context) -> SparkView { SparkView(size: size) }
    func updateNSView(_ view: SparkView, context: Context) { view.setActive(isActive) }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: SparkView, context: Context) -> CGSize? {
        CGSize(width: size, height: size)
    }
}

struct PulseRing: NSViewRepresentable {
    var isPulsing: Bool
    var diameter: CGFloat

    func makeNSView(context: Context) -> RingView { RingView(diameter: diameter) }
    func updateNSView(_ view: RingView, context: Context) { view.setPulsing(isPulsing) }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: RingView, context: Context) -> CGSize? {
        CGSize(width: diameter, height: diameter)
    }
}

struct WaitingBadge: View {
    let count: Int
    /// Pulse seulement quand une session vient de se mettre à t'attendre.
    let isPulsing: Bool

    var body: some View {
        Text("\(count)")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundStyle(.black)
            .frame(minWidth: 17, minHeight: 17)
            .background(Circle().fill(waitingAmber))
            .background(PulseRing(isPulsing: isPulsing, diameter: 17))
    }
}

// MARK: - Vues

struct CollapsedBar: View {
    @ObservedObject var store: SessionStore
    let notchSize: CGSize

    var body: some View {
        HStack(spacing: 0) {
            ClaudeSpark(isActive: !store.working.isEmpty, size: 16)
                .frame(width: Layout.earWidth)
            Color.clear.frame(width: notchSize.width)
            rightEar.frame(width: Layout.earWidth)
        }
        .frame(height: notchSize.height)
        .padding(.horizontal, Layout.flare)
    }

    @ViewBuilder
    private var rightEar: some View {
        if !store.allWaiting.isEmpty {
            WaitingBadge(count: store.allWaiting.count, isPulsing: store.hasFreshWaiting)
        } else if !store.working.isEmpty {
            Text("\(store.working.count)")
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.75))
        } else if store.unseenFinished > 0 {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(doneGreen)
        }
    }
}

struct SessionRow: View {
    let item: SessionItem
    let isUnseen: Bool
    let onOpen: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 10) {
                icon.frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(item.title)
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        if isUnseen {
                            Circle().fill(doneGreen).frame(width: 6, height: 6)
                        }
                    }
                    Text(item.detail)
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.62))
                        .lineLimit(2)
                    Text(meta)
                        .font(.system(size: 10))
                        .foregroundStyle(.white.opacity(0.38))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(isHovered ? 0.1 : 0.04)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(item.desktopId == nil ? "Ouvrir l'app de cette session" : "Ouvrir cette session dans l'app Claude")
    }

    private var meta: String {
        var parts: [String] = []
        if let project = item.project, !project.isEmpty { parts.append(project) }
        if let branch = item.branch, !branch.isEmpty { parts.append(branch) }
        if let host = item.hostBundleIds.lazy.compactMap(AppNames.name(for:)).first { parts.append(host) }
        parts.append(item.status == .working || (item.status == .waiting && item.desktopId == nil)
            ? TimeText.since(item.since)
            : TimeText.ago(item.since))
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var icon: some View {
        switch item.status {
        case .working:
            ClaudeSpark(isActive: true, size: 14)
        case .waiting:
            Image(systemName: "hand.raised.fill").font(.system(size: 13)).foregroundStyle(waitingAmber)
        case .review:
            Image(systemName: "eye.fill").font(.system(size: 12)).foregroundStyle(waitingAmber)
        case .done:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 14)).foregroundStyle(doneGreen)
        case .error:
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 13)).foregroundStyle(errorRed)
        }
    }
}

struct ExpandedPanel: View {
    @ObservedObject var store: SessionStore
    let notchSize: CGSize
    let onOpen: @MainActor (SessionItem) -> Void
    @State private var listHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                ClaudeSpark(isActive: !store.working.isEmpty, size: 15)
                Text("Claude Code")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                Spacer(minLength: notchSize.width + 12)
                Text(summary)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.white.opacity(0.55))
                    .lineLimit(1)
            }
            .frame(height: notchSize.height)

            // La liste défile au-delà de maxListHeight et épouse son contenu en deçà.
            ScrollView(.vertical, showsIndicators: false) {
                TimelineView(.periodic(from: .now, by: 15)) { _ in
                    VStack(alignment: .leading, spacing: 14) {
                        if store.items.isEmpty { emptyState }
                        section("Attendent ta réponse", store.waiting, total: store.allWaiting.count, waitingAmber)
                        section("En cours", store.working, total: store.working.count, claudeOrange)
                        section("Terminées", store.finished, total: store.finished.count, doneGreen)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onGeometryChange(for: CGFloat.self) { proxy in proxy.size.height } action: { height in
                    listHeight = height
                }
            }
            .frame(height: min(max(listHeight, 1), Layout.maxListHeight))

            HStack {
                Text("Clique une session pour l'ouvrir")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.3))
                Spacer()
                Button("Quitter") { NSApp.terminate(nil) }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.white.opacity(0.45))
            }
        }
        .padding(.horizontal, 16 + Layout.flare)
        .padding(.bottom, 14)
        .frame(width: Layout.expandedWidth)
    }

    private var summary: String {
        if !store.allWaiting.isEmpty { return "\(store.allWaiting.count) en attente" }
        if !store.working.isEmpty { return "\(store.working.count) en cours" }
        return store.finished.isEmpty ? "" : "\(store.finished.count) terminée\(store.finished.count > 1 ? "s" : "")"
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Rien en cours ni en attente")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.65))
            Text("Les sessions de l'app Claude et celles où le mod notch-status est chargé apparaissent ici.")
                .font(.system(size: 10.5))
                .foregroundStyle(.white.opacity(0.4))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func section(_ title: String, _ items: [SessionItem], total: Int, _ color: Color) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Circle().fill(color).frame(width: 6, height: 6)
                    Text(title.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.6)
                        .foregroundStyle(.white.opacity(0.5))
                    Text(total > items.count ? "\(items.count) sur \(total)" : "\(total)")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.32))
                }
                ForEach(items) { item in
                    SessionRow(item: item, isUnseen: store.isUnseen(item)) { onOpen(item) }
                }
            }
        }
    }
}

struct NotchRootView: View {
    @ObservedObject var store: SessionStore
    @ObservedObject var ui: NotchUI
    let onOpen: @MainActor (SessionItem) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if ui.expanded {
                    ExpandedPanel(store: store, notchSize: ui.notchSize, onOpen: onOpen)
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
                } else {
                    CollapsedBar(store: store, notchSize: ui.notchSize)
                        .transition(.opacity)
                }
            }
            .background(
                NotchShape(flare: Layout.flare, bottomRadius: ui.expanded ? 22 : 10)
                    .fill(Color.black)
                    .shadow(color: .black.opacity(ui.expanded ? 0.45 : 0), radius: 14, y: 6)
            )
            // La taille dessinée sert de zone de survol au panneau déplié.
            .onGeometryChange(for: CGSize.self) { proxy in proxy.size } action: { size in
                ui.contentSize = size
            }
            // Rien à signaler : l'encoche reste nue, mais le survol ouvre toujours le panneau.
            .opacity(ui.expanded || store.hasActivity ? 1 : 0)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(.easeInOut(duration: 0.25), value: store.hasActivity)
    }
}

// MARK: - Fenêtre

final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    // Laisse la fenêtre recouvrir la barre des menus.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = SessionStore()
    private let ui = NotchUI()
    private var panel: NotchPanel?
    private var metrics: NotchMetrics?
    private var tracker: Timer?
    private var hoverSince: Date?
    private var leftAt: Date?
    /// `--pinned` : le panneau reste déplié (pour le régler ou le capturer).
    private let isPinned = CommandLine.arguments.contains("--pinned")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = NotchPanel(contentRect: CGRect(origin: .zero, size: Layout.panelSize),
                               styleMask: [.borderless, .nonactivatingPanel],
                               backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.contentView = FirstClickHostingView(rootView: NotchRootView(store: store, ui: ui) { [weak self] item in
            self?.open(item)
        })
        self.panel = panel
        layout()
        panel.orderFrontRegardless()
        store.start()
        if isPinned { setExpanded(true) }

        tracker = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.layout() }
        }
    }

    private func layout() {
        guard let panel, let metrics = NotchMetrics.current() else { return }
        self.metrics = metrics
        ui.notchSize = metrics.notchSize
        let frame = metrics.screenFrame
        let size = Layout.panelSize
        panel.setFrame(CGRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height,
                              width: size.width, height: size.height), display: true)
    }

    /// Suit la souris : survol de l'encoche pour déplier, sortie du panneau pour replier.
    private func track() {
        guard let metrics, !isPinned else { return }
        let mouse = NSEvent.mouseLocation
        let frame = metrics.screenFrame
        if ui.expanded {
            let size = ui.contentSize
            let zone = CGRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height,
                              width: size.width, height: size.height + 2).insetBy(dx: -8, dy: -8)
            if zone.contains(mouse) {
                leftAt = nil
            } else if let leftAt {
                if Date().timeIntervalSince(leftAt) > 0.3 { setExpanded(false) }
            } else {
                leftAt = Date()
            }
        } else {
            // L'encoche seule suffit ; les côtés comptent quand ils sont affichés.
            let ears = store.hasActivity ? 2 * (Layout.earWidth + Layout.flare) : 0
            let width = metrics.notchSize.width + ears
            let zone = CGRect(x: frame.midX - width / 2, y: frame.maxY - metrics.notchSize.height,
                              width: width, height: metrics.notchSize.height + 2)
            if !zone.contains(mouse) {
                hoverSince = nil
            } else if let hoverSince {
                if Date().timeIntervalSince(hoverSince) > 0.12 { setExpanded(true) }
            } else {
                hoverSince = Date()
            }
        }
    }

    private func setExpanded(_ value: Bool) {
        guard ui.expanded != value, let panel else { return }
        hoverSince = nil
        leftAt = nil
        if !value { store.markSeen() }
        withAnimation(.spring(response: 0.38, dampingFraction: 0.8)) { ui.expanded = value }
        panel.ignoresMouseEvents = !value
    }

    /// Ouvre la session dans l'app Claude, ou met son terminal au premier plan.
    private func open(_ item: SessionItem) {
        setExpanded(false)
        if let desktopId = item.desktopId, let url = URL(string: "claude://claude.ai/epitaxy/\(desktopId)") {
            NSWorkspace.shared.open(url)
            return
        }
        for id in item.hostBundleIds {
            if let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first {
                app.activate()
                return
            }
        }
        for id in item.hostBundleIds {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
                NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
                return
            }
        }
        NSSound.beep()
    }
}

// MARK: - Lancement

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
