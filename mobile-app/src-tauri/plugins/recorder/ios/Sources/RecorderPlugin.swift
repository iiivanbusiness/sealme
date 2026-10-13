import AVFoundation
import SwiftRs
import Tauri
import UIKit
import WebKit

struct PathArgs: Decodable {
  let path: String
}

struct UploadArgs: Decodable {
  let path: String
  let url: String
  let token: String
  let contentType: String?
}

struct RecorderStatus: Encodable {
  // idle | recording | paused (by the person) | interrupted (by a phone
  // call or the system; carries on by itself when that's over)
  let state: String
  let seconds: Double
  // How loud the microphone is right now, 0 to 1.
  let level: Double
  // 0 to 1 while a recording is being sent.
  let uploadProgress: Double?
}

struct Recording: Encodable {
  let path: String
  let seconds: Double
  let bytes: Int64
  // Milliseconds since 1970.
  let startedAt: Double
}

struct UploadResult: Encodable {
  let status: Int
  let body: String
}

enum RecorderError: LocalizedError {
  case notStarted
  case couldNotRecord

  var errorDescription: String? {
    switch self {
    case .notStarted: return "Nothing is being recorded"
    case .couldNotRecord: return "The microphone couldn't start"
    }
  }
}

// Records meetings for the SealMe page, natively so it keeps going with the
// screen locked or another app open (UIBackgroundModes audio), and through a
// phone call (it pauses for the call and carries on after).
//
// Each recording is a folder under Application Support/recordings, named by
// when it started. The audio is AAC in ADTS (.aac): every few milliseconds
// of sound is a self-contained frame, so if the app is killed mid-meeting
// what was recorded so far is still a playable file, and parts can be
// joined by putting one after the other. A new part starts only when the
// recorder can't simply resume. stop() joins them into recording.aac, which
// upload() sends. The page deletes the folder (discard) once the notes are
// saved; anything still there is listed by pending(), so a recording is never
// lost to a crash or a failed upload.
//
// Tauri calls these on its own queue; all state lives on the main queue.
class RecorderPlugin: Plugin {
  private static let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatMPEG4AAC,
    AVSampleRateKey: 24_000,
    AVNumberOfChannelsKey: 1,
    AVEncoderBitRateKey: 48_000,
  ]

  private let session = AVAudioSession.sharedInstance()
  private var recorder: AVAudioRecorder?
  private var folder: URL?
  private var parts: [URL] = []
  // Length of the parts before the current one.
  private var earlierSeconds: Double = 0
  private var pausedByPerson = false
  private var interrupted = false
  private var uploadTask: URLSessionUploadTask?

  override init() {
    super.init()
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(interruption(_:)), name: AVAudioSession.interruptionNotification, object: session)
    center.addObserver(self, selector: #selector(mediaServicesReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: session)
  }

  // MARK: Commands

  @objc public func start(_ invoke: Invoke) {
    AVAudioApplication.requestRecordPermission { granted in
      DispatchQueue.main.async {
        guard granted else {
          invoke.reject("SealMe needs the microphone to record. Turn it on in Settings, SealMe, Microphone.", code: "denied")
          return
        }
        if self.recorder != nil {
          invoke.resolve(self.status())
          return
        }
        do {
          try self.activateSession()
          let folder = try self.recordingsRoot().appendingPathComponent(String(Int64(Date().timeIntervalSince1970 * 1000)), isDirectory: true)
          try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
          self.folder = folder
          self.parts = []
          self.earlierSeconds = 0
          self.pausedByPerson = false
          self.interrupted = false
          try self.startPart()
          invoke.resolve(self.status())
        } catch {
          self.clear()
          invoke.reject("Couldn't start recording. \(error.localizedDescription)")
        }
      }
    }
  }

  @objc public func pause(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let recorder = self.recorder else { return invoke.reject(RecorderError.notStarted.localizedDescription) }
      recorder.pause()
      self.pausedByPerson = true
      invoke.resolve(self.status())
    }
  }

  @objc public func resume(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard self.recorder != nil else { return invoke.reject(RecorderError.notStarted.localizedDescription) }
      self.pausedByPerson = false
      do {
        try self.carryOn()
        invoke.resolve(self.status())
      } catch {
        invoke.reject("Couldn't carry on recording. \(error.localizedDescription)")
      }
    }
  }

  @objc public func stop(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let recorder = self.recorder, let folder = self.folder else { return invoke.reject(RecorderError.notStarted.localizedDescription) }
      let seconds = self.earlierSeconds + recorder.currentTime
      recorder.stop()
      self.clear()
      try? self.session.setActive(false, options: .notifyOthersOnDeactivation)
      do {
        try self.writeSeconds(seconds, in: folder)
        invoke.resolve(try self.describe(folder))
      } catch {
        invoke.reject("Couldn't save the recording. \(error.localizedDescription)")
      }
    }
  }

  @objc public func status(_ invoke: Invoke) {
    DispatchQueue.main.async { invoke.resolve(self.status()) }
  }

  // Recordings that were stopped (or cut off by a crash) and not sent yet,
  // newest first.
  @objc public func pending(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do {
        let folders = try FileManager.default.contentsOfDirectory(at: self.recordingsRoot(), includingPropertiesForKeys: nil)
          .filter { $0.hasDirectoryPath && $0.standardizedFileURL != self.folder?.standardizedFileURL }
        let recordings = folders.compactMap { try? self.describe($0) }.filter { $0.bytes > 0 }.sorted { $0.startedAt > $1.startedAt }
        invoke.resolve(recordings)
      } catch {
        invoke.reject("Couldn't look for recordings. \(error.localizedDescription)")
      }
    }
  }

  @objc public func discard(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PathArgs.self)
    DispatchQueue.main.async {
      do {
        let folder = URL(fileURLWithPath: args.path).deletingLastPathComponent().standardizedFileURL
        guard folder.deletingLastPathComponent() == (try self.recordingsRoot()).standardizedFileURL, folder != self.folder?.standardizedFileURL else {
          return invoke.reject("That isn't a finished recording")
        }
        try FileManager.default.removeItem(at: folder)
        invoke.resolve()
      } catch {
        invoke.reject("Couldn't delete the recording. \(error.localizedDescription)")
      }
    }
  }

  // Sends the recording straight to the transcription service with the
  // short-lived token the page got from SealMe, and gives back its answer.
  // The upload keeps going for a while if the app is put away.
  @objc public func upload(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(UploadArgs.self)
    guard let url = URL(string: args.url), url.scheme == "https" else { return invoke.reject("That upload address isn't allowed") }
    let file = URL(fileURLWithPath: args.path).standardizedFileURL
    guard file.path.hasPrefix(try recordingsRoot().standardizedFileURL.path), FileManager.default.fileExists(atPath: file.path) else {
      return invoke.reject("That recording isn't there anymore")
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 900
    request.setValue("Bearer \(args.token)", forHTTPHeaderField: "Authorization")
    request.setValue(args.contentType ?? "audio/aac", forHTTPHeaderField: "Content-Type")

    DispatchQueue.main.async {
      var background = UIBackgroundTaskIdentifier.invalid
      background = UIApplication.shared.beginBackgroundTask(withName: "Send recording") {
        UIApplication.shared.endBackgroundTask(background)
      }
      let task = URLSession.shared.uploadTask(with: request, fromFile: file) { data, response, error in
        DispatchQueue.main.async {
          self.uploadTask = nil
          UIApplication.shared.endBackgroundTask(background)
          if let error {
            invoke.reject("Couldn't send the recording. Check your connection and try again. (\(error.localizedDescription))")
            return
          }
          let status = (response as? HTTPURLResponse)?.statusCode ?? 0
          invoke.resolve(UploadResult(status: status, body: String(decoding: data ?? Data(), as: UTF8.self)))
        }
      }
      self.uploadTask = task
      task.resume()
    }
  }

  // MARK: Recording

  private func activateSession() throws {
    try session.setCategory(.record, mode: .default, options: [])
    try session.setActive(true)
  }

  private func startPart() throws {
    guard let folder else { throw RecorderError.notStarted }
    if let current = recorder {
      earlierSeconds += current.currentTime
      current.stop()
      recorder = nil
    }
    let url = folder.appendingPathComponent(String(format: "part-%03d.aac", parts.count))
    let next = try AVAudioRecorder(url: url, settings: Self.settings)
    next.isMeteringEnabled = true
    guard next.record() else { throw RecorderError.couldNotRecord }
    recorder = next
    parts.append(url)
  }

  // After a pause or an interruption: the same part if the recorder can
  // simply go on, otherwise a new one.
  private func carryOn() throws {
    try activateSession()
    interrupted = false
    if recorder?.record() != true {
      try startPart()
    }
  }

  @objc private func interruption(_ notification: Notification) {
    guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    DispatchQueue.main.async {
      guard self.recorder != nil else { return }
      switch type {
      case .began:
        // The system has paused the recorder (a phone call, Siri, an alarm).
        self.interrupted = true
      case .ended:
        // Carry on by itself, unless the person had paused it.
        if !self.pausedByPerson { try? self.carryOn() }
      @unknown default:
        break
      }
    }
  }

  @objc private func mediaServicesReset(_ notification: Notification) {
    DispatchQueue.main.async {
      guard let current = self.recorder else { return }
      // The old recorder is gone; the next part starts fresh.
      self.earlierSeconds += current.currentTime
      self.recorder = nil
      self.interrupted = true
      if !self.pausedByPerson {
        try? self.activateSession()
        try? self.startPart()
        self.interrupted = self.recorder == nil
      }
    }
  }

  private func status() -> RecorderStatus {
    let progress = uploadTask.map { task -> Double in
      task.countOfBytesExpectedToSend > 0 ? Double(task.countOfBytesSent) / Double(task.countOfBytesExpectedToSend) : 0
    }
    guard folder != nil else {
      return RecorderStatus(state: "idle", seconds: 0, level: 0, uploadProgress: progress)
    }
    var level = 0.0
    var seconds = earlierSeconds
    if let recorder {
      seconds += recorder.currentTime
      if recorder.isRecording {
        recorder.updateMeters()
        // averagePower is in dB, -160 (silence) to 0; speech sits around -30.
        level = max(0, min(1, (Double(recorder.averagePower(forChannel: 0)) + 50) / 50))
      }
    }
    let state = pausedByPerson ? "paused" : (interrupted || recorder?.isRecording != true) ? "interrupted" : "recording"
    return RecorderStatus(state: state, seconds: seconds, level: level, uploadProgress: progress)
  }

  private func clear() {
    recorder = nil
    folder = nil
    parts = []
    earlierSeconds = 0
    pausedByPerson = false
    interrupted = false
  }

  // MARK: Files

  private func recordingsRoot() throws -> URL {
    var root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("recordings", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    // Recordings stay on the phone only until they're sent; not in backups.
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? root.setResourceValues(values)
    return root
  }

  private func writeSeconds(_ seconds: Double, in folder: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: ["seconds": seconds])
    try data.write(to: folder.appendingPathComponent("info.json"), options: .atomic)
  }

  // One recording.aac for the folder (joining the parts first if needed),
  // with how long it is and how big.
  private func describe(_ folder: URL) throws -> Recording {
    let fm = FileManager.default
    let file = folder.appendingPathComponent("recording.aac")
    let parts = try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix("part-") && $0.pathExtension == "aac" }
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    if !parts.isEmpty {
      if !fm.fileExists(atPath: file.path) { fm.createFile(atPath: file.path, contents: nil) }
      let out = try FileHandle(forWritingTo: file)
      defer { try? out.close() }
      try out.seekToEnd()
      for part in parts {
        let input = try FileHandle(forReadingFrom: part)
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
          try out.write(contentsOf: chunk)
        }
        try input.close()
        try fm.removeItem(at: part)
      }
    }
    let size = (try? fm.attributesOfItem(atPath: file.path))?[.size] as? NSNumber
    let bytes = size?.int64Value ?? 0
    var seconds = 0.0
    if let data = try? Data(contentsOf: folder.appendingPathComponent("info.json")),
       let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let stored = info["seconds"] as? Double {
      seconds = stored
    } else {
      // Cut off by a crash: estimate from the size (48 kbit/s).
      seconds = Double(bytes) * 8 / 48_000
    }
    let startedAt = Double(folder.lastPathComponent) ?? 0
    return Recording(path: file.path, seconds: seconds, bytes: bytes, startedAt: startedAt)
  }
}

@_cdecl("init_plugin_recorder")
public func initPlugin() -> Plugin {
  return RecorderPlugin()
}
