// Yada Recorder (Mac) : un gros bouton Enregistrer / Terminer.
// Capture le son du Mac (l'appel, via Core Audio, sans accès à l'écran) et le micro, en stéréo :
// canal gauche = moi (micro), canal droit = l'appel (son du Mac).
// À la fin : fichier .m4a envoyé dans Supabase Storage + une ligne dans la table calls,
// puis suppression de la copie locale. Si l'envoi échoue, le fichier attend et repart tout seul.
import AVFoundation
import CoreAudio
import Security
import NaturalLanguage
import Speech
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

// MARK: - Capture : son du Mac (Core Audio, « sons du système uniquement ») + micro (AVAudioEngine)
// Aucune autorisation d'écran : seulement « Micro » et « Enregistrement des sons du système ».

final class AudioCapture {
    private let queue = DispatchQueue(label: "yadarec.audio")
    private var writer: StereoWriter?
    private let mono48k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    private var convTap: (AVAudioFormat, AVAudioConverter)?
    private var convMic: (AVAudioFormat, AVAudioConverter)?
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var tapFormat: AVAudioFormat?
    private let engine = AVAudioEngine()
    private(set) var callPeak: Float = 0
    var onLevel: ((Int, Float) -> Void)?
    var onError: ((String) -> Void)?

    func start(to url: URL) async throws {
        writer = try StereoWriter(url: url)
        try startSystemAudio()
        try startMic()
    }

    // --- son du Mac
    private func startSystemAudio() throws {
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.uuid = UUID()
        desc.name = "Yada Recorder"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        var err = AudioHardwareCreateProcessTap(desc, &tapID)
        guard err == noErr else { throw RecError("Impossible de capter le son du Mac (tap \(err)).") }

        var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var asbd = AudioStreamBasicDescription()
        var fmtAddr = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        err = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &asbd)
        guard err == noErr, let fmt = AVAudioFormat(streamDescription: &asbd) else { throw RecError("Format du son du Mac illisible (\(err)).") }
        tapFormat = fmt

        let outputUID = try Self.defaultOutputUID()
        let agg: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Yada Recorder",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        err = AudioHardwareCreateAggregateDevice(agg as CFDictionary, &aggID)
        guard err == noErr else { throw RecError("Impossible de préparer la capture du son (\(err)).") }

        err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, queue) { [weak self] _, input, inputTime, _, _ in
            guard let self, let fmt = self.tapFormat,
                  let buf = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: input, deallocator: nil) else { return }
            let pts = AVAudioTime.seconds(forHostTime: inputTime.pointee.mHostTime)
            guard let samples = self.mono(buf, conv: &self.convTap) else { return }
            self.writer?.append(channel: 1, samples: samples, pts: pts)
            let level = Self.rms(samples)
            self.callPeak = max(self.callPeak, level)
            self.onLevel?(1, level)
        }
        guard err == noErr else { throw RecError("Impossible de lancer la capture du son (\(err)).") }
        err = AudioDeviceStart(aggID, procID)
        guard err == noErr else { throw RecError("Impossible de démarrer la capture du son (\(err)).") }
    }

    static func defaultOutputUID() throws -> String {
        var dev = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev) == noErr else { throw RecError("Aucune sortie audio trouvée.") }
        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        addr.mSelector = kAudioDevicePropertyDeviceUID
        guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &uid) == noErr, let u = uid?.takeRetainedValue() else { throw RecError("Sortie audio illisible.") }
        return u as String
    }

    // --- micro
    private func startMic() throws {
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0 else { throw RecError("Aucun micro disponible.") }
        input.installTap(onBus: 0, bufferSize: 4_096, format: fmt) { [weak self] buf, when in
            guard let self, let samples = self.mono(buf, conv: &self.convMic) else { return }
            let pts = AVAudioTime.seconds(forHostTime: when.hostTime)
            self.queue.async { self.writer?.append(channel: 0, samples: samples, pts: pts) }
            self.onLevel?(0, Self.rms(samples))
        }
        engine.prepare()
        try engine.start()
    }

    func stop() async -> Double {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if aggID != kAudioObjectUnknown {
            if let p = procID { AudioDeviceStop(aggID, p); AudioDeviceDestroyIOProcID(aggID, p) }
            AudioHardwareDestroyAggregateDevice(aggID)
        }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil
        aggID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
        return queue.sync {
            let d = writer?.finish() ?? 0
            writer = nil
            return d
        }
    }

    static func rms(_ s: [Float]) -> Float {
        guard !s.isEmpty else { return 0 }
        var sum: Float = 0
        for v in s { sum += v * v }
        return (sum / Float(s.count)).squareRoot()
    }

    /// Convertit n'importe quel format reçu en mono 48 kHz float.
    private func mono(_ src: AVAudioPCMBuffer, conv: inout (AVAudioFormat, AVAudioConverter)?) -> [Float]? {
        let fmt = src.format
        if conv == nil || conv!.0 != fmt {
            guard let c = AVAudioConverter(from: fmt, to: mono48k) else { return nil }
            c.downmix = true
            conv = (fmt, c)
        }
        let c = conv!.1
        let cap = AVAudioFrameCount(Double(src.frameLength) * 48_000 / fmt.sampleRate) + 64
        guard src.frameLength > 0, let out = AVAudioPCMBuffer(pcmFormat: mono48k, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        c.convert(to: out, error: &err) { _, status in
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
    var transcript: TranscriptResult? = nil
}

/// Transcript envoyé dans Supabase : texte lisible + répliques détaillées.
struct TranscriptResult: Codable {
    struct Turn: Codable { var speaker: String; var start: Double; var end: Double; var text: String }
    var text: String
    var language: String
    var turns: [Turn]
}

enum Uploader {
    /// Prénom de la session Mac (« Noé Campo » -> « Noé »), et sa version dossier (« noe »).
    static var person: String {
        let full = NSFullUserName().trimmingCharacters(in: .whitespaces)
        return full.split(separator: " ").first.map(String.init) ?? NSUserName()
    }
    static var personFolder: String {
        let plain = person.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased()
        let slug = plain.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII }.map(String.init).joined()
        return slug.isEmpty ? NSUserName().lowercased() : slug
    }

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

    /// Fichier audio sans fiche (app coupée en plein enregistrement) : on le récupère s'il est lisible,
    /// sinon on le met à la Corbeille.
    static func recoverOrphans(except current: String?) {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey])) ?? []
        for f in files where f.pathExtension == "m4a" {
            let id = f.deletingPathExtension().lastPathComponent
            if id == current || fm.fileExists(atPath: metaURL(id).path) { continue }
            if let af = try? AVAudioFile(forReading: f), af.length > 0 {
                let dur = Double(af.length) / af.processingFormat.sampleRate
                let created = (try? f.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
                try? save(PendingRecording(id: id, startedAt: created, endedAt: created.addingTimeInterval(dur), duration: dur))
            } else {
                try? fm.trashItem(at: f, resultingItemURL: nil)
            }
        }
    }

    static func save(_ r: PendingRecording) throws {
        try encoder.encode(r).write(to: metaURL(r.id), options: .atomic)
    }

    static func upload(_ r: PendingRecording, config: AppConfig) async throws {
        guard config.isReady else { throw RecError("Supabase n’est pas configuré.") }
        let cal = Calendar(identifier: .gregorian)
        let c = cal.dateComponents(in: TimeZone(identifier: "UTC")!, from: r.startedAt)
        let path = String(format: "%@/%04d/%02d/%@.m4a", personFolder, c.year!, c.month!, r.id)

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
        var row: [String: Any] = [
            "id": r.id, "started_at": iso.string(from: r.startedAt), "ended_at": iso.string(from: r.endedAt),
            "duration": Int(r.duration.rounded()), "audio_path": path, "status": "uploaded", "direction": "unknown",
            "recorded_by": person,
        ]
        if let t = r.transcript, !t.text.isEmpty {
            row["status"] = "transcribed"
            row["transcript_text"] = t.text
            row["language"] = t.language
            row["provider"] = "apple"
            row["transcript_json"] = [
                "language": t.language, "provider": "apple",
                "segments": t.turns.map { ["speaker": $0.speaker, "start": $0.start, "end": $0.end, "text": $0.text] },
            ]
        }
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


// MARK: - Transcription (reconnaissance vocale du Mac, hors ligne)

enum CallLanguage: String, CaseIterable, Identifiable {
    case en, fr, auto
    var id: String { rawValue }
    var label: String { self == .auto ? "Auto" : self == .fr ? "Français" : "English" }
    var locales: [String] { self == .auto ? ["fr-FR", "en-US"] : self == .fr ? ["fr-FR"] : ["en-US"] }
}

enum Transcriber {
    static let rate = 16_000.0

    static func authorized() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        default: return false
        }
    }

    static func offlineReady(_ locale: String) -> Bool {
        SFSpeechRecognizer(locale: Locale(identifier: locale))?.supportsOnDeviceRecognition ?? false
    }

    /// Lit le .m4a stéréo et renvoie [gauche (moi), droite (appel)] en mono 16 kHz.
    static func loadChannels(_ url: URL) throws -> [[Float]] {
        let file = try AVAudioFile(forReading: url)
        let src = file.processingFormat
        let dst = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: src.channelCount, interleaved: false)!
        guard let conv = AVAudioConverter(from: src, to: dst) else { throw RecError("Format audio illisible.") }
        var out = Array(repeating: [Float](), count: Int(src.channelCount))
        let step: AVAudioFrameCount = 48_000
        while file.framePosition < file.length {
            guard let inBuf = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: step) else { break }
            try file.read(into: inBuf, frameCount: step)
            if inBuf.frameLength == 0 { break }
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: dst, frameCapacity: AVAudioFrameCount(Double(inBuf.frameLength) * rate / src.sampleRate) + 64) else { break }
            var fed = false
            var err: NSError?
            conv.convert(to: outBuf, error: &err) { _, st in
                if fed { st.pointee = .noDataNow; return nil }
                fed = true
                st.pointee = .haveData
                return inBuf
            }
            for c in 0..<out.count { out[c].append(contentsOf: UnsafeBufferPointer(start: outBuf.floatChannelData![c], count: Int(outBuf.frameLength))) }
        }
        if out.count == 1 { out.append(out[0]) }
        return out
    }

    static func rms(_ s: ArraySlice<Float>) -> Float {
        guard !s.isEmpty else { return 0 }
        var sum: Float = 0
        for v in s { sum += v * v }
        return (sum / Float(s.count)).squareRoot()
    }

    /// Découpe en morceaux de 50 s max, coupés sur le passage le plus calme ; ignore les morceaux silencieux.
    static func chunks(_ s: [Float]) -> [Range<Int>] {
        let maxN = Int(50 * rate), win = Int(0.1 * rate)
        var res: [Range<Int>] = []
        var pos = 0
        while pos < s.count {
            var end = min(s.count, pos + maxN)
            if end < s.count {
                var best = end, bestE = Float.infinity
                var w = end - win
                while w > max(pos + win, end - Int(10 * rate)) {
                    let e = rms(s[w..<(w + win)])
                    if e < bestE { bestE = e; best = w + win / 2 }
                    w -= win
                }
                end = best
            }
            if rms(s[pos..<end]) > 0.004 { res.append(pos..<end) }
            pos = end
        }
        return res
    }

    static func writeTemp(_ s: ArraySlice<Float>) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yadarec-\(UUID().uuidString).caf")
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        let f = try AVAudioFile(forWriting: url, settings: fmt.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(s.count))!
        buf.frameLength = AVAudioFrameCount(s.count)
        s.withUnsafeBufferPointer { buf.floatChannelData![0].update(from: $0.baseAddress!, count: s.count) }
        try f.write(from: buf)
        return url
    }

    @MainActor
    static func recognize(_ url: URL, locale: String) async throws -> SFTranscription? {
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)) else { throw RecError("Langue \(locale) indisponible.") }
        let req = SFSpeechURLRecognitionRequest(url: url)
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = false
        req.addsPunctuation = true
        return try await withCheckedThrowingContinuation { c in
            var done = false
            var task: SFSpeechRecognitionTask?
            task = r.recognitionTask(with: req) { result, error in
                if done { return }
                if let result, result.isFinal {
                    done = true
                    c.resume(returning: result.bestTranscription)
                } else if let error {
                    done = true
                    let code = (error as NSError).code
                    // 1110 = aucune parole détectée : morceau vide, pas une erreur
                    if code == 1110 || code == 203 { c.resume(returning: nil) } else { c.resume(throwing: error) }
                }
                _ = task
            }
        }
    }

    struct Word { let speaker: Int; let t: Double; let end: Double; let text: String }

    @MainActor
    static func detectLocale(_ clip: URL) async -> String {
        if offlineReady("en-US"), let en = try? await recognize(clip, locale: "en-US"), !en.segments.isEmpty {
            let conf = en.segments.map { Double($0.confidence) }.reduce(0, +) / Double(en.segments.count)
            if conf >= 0.6 { return "en-US" }
        }
        if offlineReady("fr-FR"), let fr = try? await recognize(clip, locale: "fr-FR") {
            let nl = NLLanguageRecognizer()
            nl.processString(fr.formattedString)
            if (nl.languageHypotheses(withMaximum: 3)[.french] ?? 0) >= 0.6 { return "fr-FR" }
        }
        return "en-US"
    }

    @MainActor
    static func transcribe(_ url: URL, language: CallLanguage, progress: @escaping (Double) -> Void) async throws -> TranscriptResult {
        let ch = try await Task.detached { try loadChannels(url) }.value
        var plan: [(speaker: Int, range: Range<Int>)] = []
        for (i, c) in ch.prefix(2).enumerated() { for r in chunks(c) { plan.append((i, r)) } }
        var locale = language.locales[0]
        if plan.isEmpty { return TranscriptResult(text: "", language: String(locale.prefix(2)), turns: []) }

        if language == .auto {
            // Sur un extrait (l'interlocuteur en priorité) : anglais si le moteur anglais est sûr de lui,
            // sinon français si le texte reconnu en français est bien du français, sinon anglais.
            let probe = plan.first { $0.speaker == 1 } ?? plan[0]
            let clip = ch[probe.speaker][probe.range.lowerBound..<min(probe.range.upperBound, probe.range.lowerBound + Int(20 * rate))]
            let tmp = try writeTemp(clip)
            defer { try? FileManager.default.removeItem(at: tmp) }
            locale = await detectLocale(tmp)
        }

        var words: [Word] = []
        for (i, p) in plan.enumerated() {
            let tmp = try writeTemp(ch[p.speaker][p.range])
            defer { try? FileManager.default.removeItem(at: tmp) }
            if let tr = try await recognize(tmp, locale: locale) {
                let offset = Double(p.range.lowerBound) / rate
                for seg in tr.segments {
                    words.append(Word(speaker: p.speaker, t: offset + seg.timestamp, end: offset + seg.timestamp + seg.duration, text: seg.substring))
                }
            }
            progress(Double(i + 1) / Double(plan.count))
        }
        let turns = mergeTurns(words)
        return TranscriptResult(text: format(turns), language: String(locale.prefix(2)), turns: turns.map {
            TranscriptResult.Turn(speaker: $0.speaker == 0 ? "me" : "them", start: ($0.start * 100).rounded() / 100, end: ($0.end * 100).rounded() / 100, text: $0.text)
        })
    }

    static func mergeTurns(_ words: [Word]) -> [(speaker: Int, start: Double, end: Double, text: String)] {
        var turns: [(speaker: Int, start: Double, end: Double, text: String)] = []
        for w in words.sorted(by: { $0.t < $1.t }) {
            if var last = turns.last, last.speaker == w.speaker, w.t - last.end < 1.5 {
                last.text += " " + w.text
                last.end = w.end
                turns[turns.count - 1] = last
            } else {
                turns.append((w.speaker, w.t, w.end, w.text))
            }
        }
        return turns
    }

    /// Une ligne par prise de parole : "[00:12] Moi : …" / "[00:15] Interlocuteur : …"
    static func format(_ turns: [(speaker: Int, start: Double, end: Double, text: String)]) -> String {
        turns.map { t in
            let s = Int(t.start)
            return String(format: "[%02d:%02d] %@ : %@", s / 60, s % 60, t.speaker == 0 ? "Moi" : "Interlocuteur", t.text)
        }.joined(separator: "\n")
    }
}

// MARK: - Premier lancement : autorisations et dictée hors ligne

enum Setup {
    static let settings = [
        "mic": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        "screen": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "speech": "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
        "dictation": "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
    ]
    static func open(_ key: String) {
        if let u = URL(string: settings[key] ?? "") { NSWorkspace.shared.open(u) }
    }

    /// L'autorisation « son du Mac » ne s'applique qu'après un redémarrage de l'app.
    static func relaunch() {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: cfg) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

struct SetupIssue: Identifiable {
    let id: String
    let text: String
}

// MARK: - Modèle de l'interface

@MainActor
final class Recorder: ObservableObject {
    enum Phase: Equatable { case idle, starting, recording, finishing, transcribing(Double), uploading, sent(String), failed(String) }

    @Published var phase: Phase = .idle
    @Published var elapsed: TimeInterval = 0
    @Published var levels: [Float] = [0, 0]
    @Published var pendingCount = 0
    @Published var config = AppConfig.load()
    @Published var transcript = ""
    @Published var transcriptNote = ""
    @Published var issues: [SetupIssue] = []
    @Published var language: CallLanguage = CallLanguage(rawValue: UserDefaults.standard.string(forKey: "language") ?? "") ?? .en {
        didSet { UserDefaults.standard.set(language.rawValue, forKey: "language") }
    }

    private var capture: AudioCapture?
    private var current: PendingRecording?
    private var timer: Timer?
    private var retryTimer: Timer?

    init() {
        Uploader.recoverOrphans(except: nil)
        refreshPending()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.uploadPending() }
        }
        Task { await uploadPending() }
        if !CommandLine.arguments.contains(where: { $0.hasPrefix("--selftest") }) { Task { await firstRunSetup() } }
    }

    /// Demande d'un coup les 3 autorisations et vérifie la dictée hors ligne FR/EN.
    /// Ouvre tout seul le bon écran des Réglages quand il manque quelque chose.
    func firstRunSetup() async {
        _ = await AVCaptureDevice.requestAccess(for: .audio)
        _ = await Transcriber.authorized()
        checkSetup()
        let missingDictation = issues.contains { $0.id == "dictation" }
        if missingDictation && !UserDefaults.standard.bool(forKey: "openedDictation") {
            UserDefaults.standard.set(true, forKey: "openedDictation")
            Setup.open("dictation")
        }
    }

    func checkSetup() {
        var list: [SetupIssue] = []
        if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
            list.append(SetupIssue(id: "mic", text: "Autoriser le micro"))
        }
        if UserDefaults.standard.bool(forKey: "callAudioSilent") {
            list.append(SetupIssue(id: "screen", text: "Le son de l’appel n’a pas été capté : autorise Yada Recorder dans « Enregistrement des sons du système uniquement », puis Relancer"))
        }
        if SFSpeechRecognizer.authorizationStatus() != .authorized {
            list.append(SetupIssue(id: "speech", text: "Autoriser la reconnaissance vocale"))
        }
        let missing = ["fr-FR": "français", "en-US": "anglais"].filter { !Transcriber.offlineReady($0.key) }.map { $0.value }.sorted()
        if !missing.isEmpty {
            list.append(SetupIssue(id: "dictation", text: "Installer la dictée en \(missing.joined(separator: " et ")) (Clavier > Dictée)"))
        }
        issues = list
    }

    var isRecording: Bool { phase == .recording || phase == .starting }
    var isBusy: Bool {
        switch phase {
        case .starting, .finishing, .uploading, .transcribing: return true
        default: return false
        }
    }

    func toggle() {
        switch phase {
        case .recording: Task { await stop() }
        case .starting, .finishing, .uploading, .transcribing: break
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
            phase = .failed("Impossible de capter le son : \(error.localizedDescription)")
            _ = await cap.stop()
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

    /// Arrêt rapide (l'app se ferme) : fichier finalisé et mis en attente, envoi au prochain lancement.
    func stopForQuit() async {
        guard let cap = capture, var rec = current else { return }
        timer?.invalidate()
        rec.duration = await cap.stop()
        rec.endedAt = Date()
        capture = nil
        current = nil
        try? Uploader.save(rec)
    }

    func stop() async {
        guard let cap = capture, var rec = current else { return }
        phase = .finishing
        timer?.invalidate()
        let duration = await cap.stop()
        UserDefaults.standard.set(duration > 8 && cap.callPeak < 0.0003, forKey: "callAudioSilent")
        checkSetup()
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
        await transcribe(&rec)
        await send(rec)
    }

    func transcribe(_ rec: inout PendingRecording) async {
        guard await Transcriber.authorized() else {
            transcriptNote = "Transcription impossible : autorise la reconnaissance vocale."
            checkSetup()
            return
        }
        phase = .transcribing(0)
        do {
            let result = try await Transcriber.transcribe(Uploader.audioURL(rec.id), language: language) { p in
                Task { @MainActor in if case .transcribing = self.phase { self.phase = .transcribing(p) } }
            }
            transcript = result.text
            transcriptNote = result.text.isEmpty ? "Aucune parole détectée." : ""
            rec.transcript = result
            try? Uploader.save(rec)
        } catch {
            transcriptNote = "Transcription impossible : \(error.localizedDescription)"
            checkSetup()
        }
    }

    func copyTranscript() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(transcript, forType: .string)
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
        guard !isRecording, phase != .uploading, phase != .finishing, config.isReady else { return }
        if case .transcribing = phase { return }
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
    @State private var copied = false

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
            .keyboardShortcut("r", modifiers: [.command])
            .help("Enregistrer / Terminer (⌘R)")
            .disabled(rec.isBusy)

            if !rec.isRecording {
                Picker("Langue de l’appel", selection: $rec.language) {
                    ForEach(CallLanguage.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 240)
                .help("English par défaut. Auto devine la langue sur les premières secondes de l’appel.")
            }

            if rec.isRecording {
                VStack(spacing: 8) {
                    LevelBar(label: "Moi", value: rec.levels[0])
                    LevelBar(label: "Appel", value: rec.levels[1])
                }.frame(width: 240)
            }

            status.font(.system(size: 13)).multilineTextAlignment(.center).frame(maxWidth: 300)

            if !rec.issues.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("À régler une fois").font(.system(size: 12, weight: .semibold))
                    ForEach(rec.issues) { issue in
                        HStack {
                            Text("⚠︎ \(issue.text)").font(.system(size: 12))
                            Spacer()
                            Button("Ouvrir") { Setup.open(issue.id) }.controlSize(.small)
                            if issue.id == "screen" {
                                Button("Relancer") { Setup.relaunch() }.controlSize(.small)
                            }
                        }
                    }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.12)))
                .frame(maxWidth: .infinity)
            }

            if !rec.transcript.isEmpty || !rec.transcriptNote.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Transcript").font(.system(size: 13, weight: .semibold))
                        Spacer()
                        if !rec.transcript.isEmpty {
                            Button(copied ? "Copié ✓" : "Copier") {
                                rec.copyTranscript()
                                copied = true
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                            }
                            .keyboardShortcut("c", modifiers: [.command, .shift])
                        }
                    }
                    if !rec.transcriptNote.isEmpty {
                        Text(rec.transcriptNote).font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    if !rec.transcript.isEmpty {
                        ScrollView {
                            Text(rec.transcript)
                                .font(.system(size: 12.5))
                                .lineSpacing(3)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                        }
                        .frame(minHeight: 140, maxHeight: .infinity)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

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
        .frame(minWidth: 420, maxWidth: .infinity, minHeight: 440, maxHeight: .infinity)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in rec.checkSetup() }
        .onAppear { AppDelegate.recorder = rec }
    }

    @ViewBuilder var status: some View {
        switch rec.phase {
        case .idle: Text("Clique pour enregistrer le son de ton appel.").foregroundStyle(.secondary)
        case .starting: Text("Démarrage…").foregroundStyle(.secondary)
        case .recording: Text("● Enregistrement en cours").foregroundStyle(.red)
        case .finishing: Text("Finalisation du fichier…").foregroundStyle(.secondary)
        case .transcribing(let p): Text("Transcription… \(Int(p * 100)) %").foregroundStyle(.secondary)
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
        if let i = args.firstIndex(of: "--selftest-capture"), i + 2 < args.count {
            // --selftest-capture <secondes> <sortie.m4a> : enregistre puis écrit un résumé dans <sortie>.txt
            let secs = Double(args[i + 1]) ?? 8, out = URL(fileURLWithPath: args[i + 2])
            Task { @MainActor in
                var lines: [String] = []
                _ = await AVCaptureDevice.requestAccess(for: .audio)
                let cap = AudioCapture()
                var micPeak: Float = 0
                cap.onLevel = { ch, v in if ch == 0 { micPeak = max(micPeak, v) } }
                do {
                    try await cap.start(to: out)
                    try await Task.sleep(nanoseconds: UInt64(secs * 1e9))
                    let d = await cap.stop()
                    lines.append("durée=\(d) picAppel=\(cap.callPeak) picMicro=\(micPeak)")
                } catch { lines.append("ERREUR: \(error.localizedDescription)") }
                try? lines.joined(separator: "\n").write(to: out.appendingPathExtension("txt"), atomically: true, encoding: .utf8)
                exit(0)
            }
            return
        }
        if let i = args.firstIndex(of: "--selftest-probe"), i + 2 < args.count {
            let input = URL(fileURLWithPath: args[i + 1]), output = URL(fileURLWithPath: args[i + 2])
            Task { @MainActor in
                var lines: [String] = []
                _ = await Transcriber.authorized()
                if let ch = try? Transcriber.loadChannels(input) {
                    for sp in 0..<2 {
                        guard let r = Transcriber.chunks(ch[sp]).first, let tmp = try? Transcriber.writeTemp(ch[sp][r]) else { continue }
                        for l in ["fr-FR", "en-US"] {
                            let tr = try? await Transcriber.recognize(tmp, locale: l)
                            let segs = tr?.segments ?? []
                            let conf = segs.isEmpty ? 0 : segs.map { Double($0.confidence) }.reduce(0, +) / Double(segs.count)
                            let text = tr?.formattedString ?? ""
                            let nl = NLLanguageRecognizer(); nl.processString(text)
                            let hyp = nl.languageHypotheses(withMaximum: 2).map { "\($0.key.rawValue)=\(String(format: "%.2f", $0.value))" }.joined(separator: ",")
                            lines.append("canal \(sp) \(l) conf=\(String(format: "%.2f", conf)) nl=[\(hyp)] : \(text)")
                        }
                    }
                }
                try? lines.joined(separator: "\n").write(to: output, atomically: true, encoding: .utf8)
                exit(0)
            }
            return
        }
        if let i = args.firstIndex(of: "--selftest-transcribe"), i + 2 < args.count {
            // --selftest-transcribe <entrée.m4a> <sortie.txt> [auto|fr|en]
            let input = URL(fileURLWithPath: args[i + 1]), output = URL(fileURLWithPath: args[i + 2])
            let lang = CallLanguage(rawValue: i + 3 < args.count ? args[i + 3] : "auto") ?? .auto
            Task { @MainActor in
                var text: String
                if await Transcriber.authorized() {
                    do { text = try await Transcriber.transcribe(input, language: lang) { _ in }.text }
                    catch { text = "ERREUR: \(error.localizedDescription)" }
                } else { text = "ERREUR: reconnaissance vocale non autorisée" }
                try? text.write(to: output, atomically: true, encoding: .utf8)
                exit(0)
            }
            return
        }
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

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static weak var recorder: Recorder?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let r = MainActor.assumeIsolated({ Self.recorder }), MainActor.assumeIsolated({ r.isRecording }) else { return .terminateNow }
        Task { @MainActor in
            await r.stopForQuit()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@main
struct YadaRecorderApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    init() { SelfTest.runIfAsked() }
    var body: some Scene {
        WindowGroup("Yada Recorder") { ContentView() }
            .windowResizability(.contentMinSize)
            .defaultSize(width: 560, height: 680)
    }
}
