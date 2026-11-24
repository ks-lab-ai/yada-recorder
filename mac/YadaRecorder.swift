// Yada Recorder (Mac) : un gros bouton Enregistrer / Terminer.
// Capture le son du Mac (l'appel, via ScreenCaptureKit) et le micro, en stéréo :
// canal gauche = moi (micro), canal droit = l'appel (son du Mac).
// À la fin : fichier .m4a envoyé dans Supabase Storage + une ligne dans la table calls,
// puis suppression de la copie locale. Si l'envoi échoue, le fichier attend et repart tout seul.
import AVFoundation
import ScreenCaptureKit
import Security
import SwiftUI

// MARK: - Configuration (Config.plist dans l'app, sinon clé collée dans l'app et gardée dans le Trousseau)

struct AppConfig {
    var url: String
    var key: String
    var bucket: String

    static func load() -> AppConfig {
        var url = "", key = "", bucket = "call-recordings"
        if let p = Bundle.main.url(forResource: "Config", withExtension: "plist"),
           let d = NSDictionary(contentsOf: p) as? [String: String] {
            url = d["SupabaseURL"] ?? ""
            key = d["SupabaseKey"] ?? ""
            bucket = d["Bucket"].flatMap { $0.isEmpty ? nil : $0 } ?? bucket
        }
        if let k = Keychain.get("supabaseKey"), !k.isEmpty { key = k }
        if let u = UserDefaults.standard.string(forKey: "supabaseURL"), !u.isEmpty { url = u }
        return AppConfig(url: url.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")), key: key, bucket: bucket)
    }

    var isReady: Bool { url.hasPrefix("https://") && !key.isEmpty }
}

enum Keychain {
    static let service = "Yada Recorder"
    static func get(_ account: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func set(_ account: String, _ value: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}

// MARK: - Écriture stéréo synchronisée (gauche = micro, droite = son du Mac)

final class StereoWriter {
    static let rate = 48_000.0
    private var file: AVAudioFile?
    private var chans: [[Float]] = [[], []]
    private(set) var written = 0
    private var t0: Double?
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false)!

    init(url: URL) throws {
        file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: Self.rate,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 64_000,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    /// Place les échantillons d'un canal à la position donnée par leur horodatage.
    func append(channel: Int, samples: [Float], pts: Double) {
        if t0 == nil { t0 = pts }
        let start = Int(((pts - t0!) * Self.rate).rounded())
        let end = written + chans[channel].count
        var data = samples[...]
        if start > end {
            chans[channel].append(contentsOf: repeatElement(0, count: start - end))
        } else if start < end {
            data = data.dropFirst(min(end - start, data.count))
        }
        chans[channel].append(contentsOf: data)
        flush(final: false)
    }

    func flush(final: Bool) {
        let lag = Int(Self.rate) // un canal muet (pas de son du Mac, micro coupé) ne bloque pas l'autre plus d'1 s
        for c in 0..<2 {
            let other = chans[1 - c].count
            let target = final ? other : other - lag
            if chans[c].count < target { chans[c].append(contentsOf: repeatElement(0, count: target - chans[c].count)) }
        }
        let n = min(chans[0].count, chans[1].count)
        guard n >= (final ? 1 : 4_800), let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)) else { return }
        buf.frameLength = AVAudioFrameCount(n)
        for c in 0..<2 {
            chans[c].withUnsafeBufferPointer { src in
                buf.floatChannelData![c].update(from: src.baseAddress!, count: n)
            }
            chans[c].removeFirst(n)
        }
        try? file?.write(from: buf)
        written += n
    }

    func finish() -> Double {
        flush(final: true)
        file = nil // ferme et finalise le .m4a
        return Double(written) / Self.rate
    }
}

// MARK: - Capture ScreenCaptureKit (son du Mac + micro)

final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "yadarec.audio")
    private var writer: StereoWriter?
    private var converters: [Int: (AVAudioFormat, AVAudioConverter)] = [:]
    private let mono48k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    var onLevel: ((Int, Float) -> Void)?
    var onError: ((String) -> Void)?

    func start(to url: URL) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw RecError("Aucun écran trouvé pour capter le son.") }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.captureMicrophone = true
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        writer = try StereoWriter(url: url)
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
    }

    func stop() async -> Double {
        if let s = stream { try? await s.stopCapture() }
        stream = nil
        return queue.sync {
            let d = writer?.finish() ?? 0
            writer = nil
            converters = [:]
            return d
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError?("La capture s’est arrêtée : \(error.localizedDescription)")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        let channel: Int
        switch type {
        case .microphone: channel = 0
        case .audio: channel = 1
        default: return
        }
        guard sb.isValid, let samples = monoSamples(sb, key: channel) else { return }
        writer?.append(channel: channel, samples: samples, pts: CMSampleBufferGetPresentationTimeStamp(sb).seconds)
        var sum: Float = 0
        for v in samples { sum += v * v }
        onLevel?(channel, samples.isEmpty ? 0 : (sum / Float(samples.count)).squareRoot())
    }

    /// Convertit n'importe quel format reçu en mono 48 kHz float.
    private func monoSamples(_ sb: CMSampleBuffer, key: Int) -> [Float]? {
        guard let fd = CMSampleBufferGetFormatDescription(sb),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fd) else { return nil }
        var asbd = asbdPtr.pointee
        guard let fmt = AVAudioFormat(streamDescription: &asbd) else { return nil }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
        guard frames > 0, let src = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return nil }
        src.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: src.mutableAudioBufferList) == noErr else { return nil }

        if converters[key] == nil || converters[key]!.0 != fmt {
            guard let c = AVAudioConverter(from: fmt, to: mono48k) else { return nil }
            c.downmix = true
            converters[key] = (fmt, c)
        }
        let conv = converters[key]!.1
        let cap = AVAudioFrameCount(Double(frames) * 48_000 / fmt.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: mono48k, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return src
        }
        guard err == nil, let p = out.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: p, count: Int(out.frameLength)))
    }
}

struct RecError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

// MARK: - Envoi vers Supabase (+ file d'attente sur disque)

struct PendingRecording: Codable {
    var id: String
    var startedAt: Date
    var endedAt: Date
    var duration: Double
}

enum Uploader {
    static var dir: URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Yada Recorder/recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    static func pending() -> [PendingRecording] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap {
            guard let d = try? Data(contentsOf: $0) else { return nil }
            return try? decoder.decode(PendingRecording.self, from: d)
        }.sorted { $0.startedAt < $1.startedAt }
    }

    static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()

    static func audioURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).m4a") }
    static func metaURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }

    static func save(_ r: PendingRecording) throws {
        try encoder.encode(r).write(to: metaURL(r.id), options: .atomic)
    }

    static func upload(_ r: PendingRecording, config: AppConfig) async throws {
        guard config.isReady else { throw RecError("Supabase n’est pas configuré.") }
        let cal = Calendar(identifier: .gregorian)
        let c = cal.dateComponents(in: TimeZone(identifier: "UTC")!, from: r.startedAt)
        let path = String(format: "%04d/%02d/%@.m4a", c.year!, c.month!, r.id)

        var up = URLRequest(url: URL(string: "\(config.url)/storage/v1/object/\(config.bucket)/\(path)")!)
        up.httpMethod = "POST"
        up.setValue(config.key, forHTTPHeaderField: "apikey")
        if config.key.hasPrefix("eyJ") { up.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization") }
        up.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        up.timeoutInterval = 600
        let (d1, r1) = try await URLSession.shared.upload(for: up, fromFile: audioURL(r.id))
        let s1 = (r1 as? HTTPURLResponse)?.statusCode ?? 0
        let body1 = String(data: d1, encoding: .utf8) ?? ""
        // 409 / "Duplicate" : déjà envoyé lors d'un essai précédent.
        guard (200..<300).contains(s1) || body1.contains("Duplicate") || s1 == 409 else {
            throw RecError("Envoi du fichier refusé (\(s1)) : \(body1.prefix(200))")
        }

        let iso = ISO8601DateFormatter()
        let row: [String: Any] = [
            "id": r.id, "started_at": iso.string(from: r.startedAt), "ended_at": iso.string(from: r.endedAt),
            "duration": Int(r.duration.rounded()), "audio_path": path, "status": "uploaded", "direction": "unknown",
        ]
        var ins = URLRequest(url: URL(string: "\(config.url)/rest/v1/calls")!)
        ins.httpMethod = "POST"
        ins.setValue(config.key, forHTTPHeaderField: "apikey")
        if config.key.hasPrefix("eyJ") { ins.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization") }
        ins.setValue("application/json", forHTTPHeaderField: "Content-Type")
        ins.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        ins.httpBody = try JSONSerialization.data(withJSONObject: row)
        let (d2, r2) = try await URLSession.shared.data(for: ins)
        let s2 = (r2 as? HTTPURLResponse)?.statusCode ?? 0
        let body2 = String(data: d2, encoding: .utf8) ?? ""
        guard (200..<300).contains(s2) || body2.contains("23505") else { // 23505 = ligne déjà présente
            throw RecError("Enregistrement de l’appel refusé (\(s2)) : \(body2.prefix(200))")
        }

        try? FileManager.default.removeItem(at: audioURL(r.id))
        try? FileManager.default.removeItem(at: metaURL(r.id))
    }
}

// MARK: - Modèle de l'interface

@MainActor
final class Recorder: ObservableObject {
    enum Phase: Equatable { case idle, starting, recording, finishing, uploading, sent(String), failed(String) }

    @Published var phase: Phase = .idle
    @Published var elapsed: TimeInterval = 0
    @Published var levels: [Float] = [0, 0]
    @Published var pendingCount = 0
    @Published var config = AppConfig.load()

    private var capture: AudioCapture?
    private var current: PendingRecording?
    private var timer: Timer?
    private var retryTimer: Timer?

    init() {
        refreshPending()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.uploadPending() }
        }
        Task { await uploadPending() }
    }

    var isRecording: Bool { phase == .recording || phase == .starting }

    func toggle() {
        switch phase {
        case .recording: Task { await stop() }
        case .starting, .finishing, .uploading: break
        default: Task { await start() }
        }
    }

    func start() async {
        phase = .starting
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        if !granted {
            phase = .failed("Micro refusé : Réglages Système > Confidentialité et sécurité > Micro > Yada Recorder.")
            return
        }
        let id = UUID().uuidString.lowercased()
        let cap = AudioCapture()
        cap.onLevel = { [weak self] ch, v in
            DispatchQueue.main.async { self?.levels[ch] = max(v, (self?.levels[ch] ?? 0) * 0.8) }
        }
        cap.onError = { [weak self] msg in
            DispatchQueue.main.async { Task { await self?.stop(); self?.phase = .failed(msg) } }
        }
        do {
            try await cap.start(to: Uploader.audioURL(id))
        } catch {
            phase = .failed("Impossible de capter le son du Mac. Autorise Yada Recorder dans Réglages Système > Confidentialité et sécurité > Enregistrement de l’écran et de l’audio système, puis relance l’app. (\(error.localizedDescription))")
            return
        }
        capture = cap
        current = PendingRecording(id: id, startedAt: Date(), endedAt: Date(), duration: 0)
        elapsed = 0
        phase = .recording
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let c = self.current else { return }
                self.elapsed = Date().timeIntervalSince(c.startedAt)
                self.levels = self.levels.map { $0 * 0.85 }
            }
        }
    }

    func stop() async {
        guard let cap = capture, var rec = current else { return }
        phase = .finishing
        timer?.invalidate()
        let duration = await cap.stop()
        capture = nil
        rec.endedAt = Date()
        rec.duration = duration
        current = nil
        levels = [0, 0]
        do {
            try Uploader.save(rec)
        } catch {
            phase = .failed("Impossible d’enregistrer le fichier : \(error.localizedDescription)")
            return
        }
        refreshPending()
        await send(rec)
    }

    func send(_ rec: PendingRecording) async {
        phase = .uploading
        do {
            try await Uploader.upload(rec, config: config)
            phase = .sent("Envoyé dans Supabase (\(Self.format(rec.duration)))")
        } catch {
            phase = .failed("Pas encore envoyé, nouvel essai automatique : \(error.localizedDescription)")
        }
        refreshPending()
    }

    func uploadPending() async {
        guard !isRecording, phase != .uploading, config.isReady else { return }
        for r in Uploader.pending() where r.id != current?.id {
            do { try await Uploader.upload(r, config: config) } catch { break }
        }
        refreshPending()
    }

    func saveKey(_ key: String, url: String) {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if !k.isEmpty { Keychain.set("supabaseKey", k) }
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if !u.isEmpty { UserDefaults.standard.set(u, forKey: "supabaseURL") }
        config = AppConfig.load()
        Task { await uploadPending() }
    }

    func refreshPending() { pendingCount = Uploader.pending().count }

    static func format(_ t: TimeInterval) -> String {
        let s = Int(t.rounded(.down))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s % 3600 / 60, s % 60) : String(format: "%02d:%02d", s / 60, s % 60)
    }
}

// MARK: - Interface

struct LevelBar: View {
    let label: String
    let value: Float
    var body: some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary).frame(width: 46, alignment: .leading)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.18))
                    Capsule().fill(Color(red: 0.16, green: 0.86, blue: 0.55))
                        .frame(width: g.size.width * CGFloat(min(1, value * 12)))
                }
            }.frame(height: 7)
        }
    }
}

struct ContentView: View {
    @StateObject private var rec = Recorder()
    @State private var keyField = ""
    @State private var urlField = ""

    var body: some View {
        VStack(spacing: 22) {
            Button(action: rec.toggle) {
                ZStack {
                    Circle()
                        .fill(rec.isRecording ? Color(red: 0.86, green: 0.15, blue: 0.15) : Color(red: 0.16, green: 0.86, blue: 0.55))
                        .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
                    VStack(spacing: 8) {
                        Image(systemName: rec.isRecording ? "stop.fill" : "record.circle")
                            .font(.system(size: 44, weight: .bold))
                        Text(rec.isRecording ? "Terminer" : "Enregistrer")
                            .font(.system(size: 19, weight: .semibold))
                        if rec.isRecording {
                            Text(Recorder.format(rec.elapsed)).font(.system(size: 15, weight: .medium).monospacedDigit())
                        }
                    }.foregroundStyle(.white)
                }
                .frame(width: 190, height: 190)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.space, modifiers: [])
            .disabled([.starting, .finishing, .uploading].contains(rec.phase))

            if rec.isRecording {
                VStack(spacing: 8) {
                    LevelBar(label: "Moi", value: rec.levels[0])
                    LevelBar(label: "Appel", value: rec.levels[1])
                }.frame(width: 240)
            }

            status.font(.system(size: 13)).multilineTextAlignment(.center).frame(maxWidth: 300)

            if rec.pendingCount > 0 && !rec.isRecording {
                Text("\(rec.pendingCount) enregistrement(s) en attente d’envoi").font(.system(size: 12)).foregroundStyle(.orange)
            }

            if !rec.config.isReady {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Supabase").font(.system(size: 12, weight: .semibold))
                    if !rec.config.url.hasPrefix("https://") {
                        TextField("https://xxxx.supabase.co", text: $urlField).textFieldStyle(.roundedBorder)
                    }
                    SecureField("Clé Supabase", text: $keyField).textFieldStyle(.roundedBorder)
                    Button("Enregistrer la clé") { rec.saveKey(keyField, url: urlField); keyField = "" }
                }.frame(width: 280)
            }
        }
        .padding(28)
        .frame(width: 360)
        .frame(minHeight: 400)
    }

    @ViewBuilder var status: some View {
        switch rec.phase {
        case .idle: Text("Clique pour enregistrer le son de ton appel.").foregroundStyle(.secondary)
        case .starting: Text("Démarrage…").foregroundStyle(.secondary)
        case .recording: Text("● Enregistrement en cours").foregroundStyle(.red)
        case .finishing: Text("Finalisation du fichier…").foregroundStyle(.secondary)
        case .uploading: Text("Envoi vers Supabase…").foregroundStyle(.secondary)
        case .sent(let m): Text("✓ \(m)").foregroundStyle(.green)
        case .failed(let m): Text(m).foregroundStyle(.red)
        }
    }
}

/// Auto-test sans micro ni permission : `Yada Recorder --selftest-writer /chemin/out.m4a`
/// écrit 3 s de stéréo (300 Hz à gauche, 1200 Hz à droite, envoyés par petits blocs décalés comme en vrai).
enum SelfTest {
    static func runIfAsked() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--selftest-writer"), i + 1 < args.count else { return }
        let url = URL(fileURLWithPath: args[i + 1])
        do {
            let w = try StereoWriter(url: url)
            let block = 480 // 10 ms
            for b in 0..<300 {
                for (ch, f) in [(0, 300.0), (1, 1200.0)] {
                    if ch == 1 && b >= 100 && b < 130 { continue } // trou de 300 ms côté "appel"
                    let start = b * block
                    let s = (0..<block).map { Float(0.3 * sin(2 * .pi * f * Double(start + $0) / 48_000)) }
                    w.append(channel: ch, samples: s, pts: 100 + Double(start) / 48_000 + (ch == 1 ? 0.0004 : 0))
                }
            }
            print("durée écrite : \(w.finish()) s")
            exit(0)
        } catch {
            print("échec : \(error)")
            exit(1)
        }
    }
}

@main
struct YadaRecorderApp: App {
    init() { SelfTest.runIfAsked() }
    var body: some Scene {
        WindowGroup("Yada Recorder") { ContentView() }
            .windowResizability(.contentSize)
    }
}
