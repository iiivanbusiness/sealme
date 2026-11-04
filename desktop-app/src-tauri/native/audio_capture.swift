// Native call capture for SealMe desktop, exposed to Rust via a C ABI.
//
// Two independent sources are captured for the duration of the call and
// mixed into a single stereo WAV on stop:
//   - left channel:  system audio output (ScreenCaptureKit) — the other
//     person's voice, since that's what plays through your speakers
//   - right channel: your microphone (AVAudioEngine) — your own voice,
//     which normally never gets echoed back through the speakers, so
//     ScreenCaptureKit alone would only capture half the conversation
// Deepgram transcribes each channel separately (multichannel mode), so the
// two speakers come back reliably labeled instead of guessed via diarization.
// There is no live processing here — the whole point is to mirror the
// existing "record, then transcribe once the call ends" flow, just without a
// visible bot in the meeting.

import ScreenCaptureKit
import AVFoundation

private extension Data {
    mutating func appendLE(_ value: UInt32) {
        let v = value.littleEndian
        append(contentsOf: Swift.withUnsafeBytes(of: v) { Array($0) })
    }
    mutating func appendLE(_ value: UInt16) {
        let v = value.littleEndian
        append(contentsOf: Swift.withUnsafeBytes(of: v) { Array($0) })
    }
}

private let captureSampleRate: Double = 16000

// MARK: - Microphone capture

final class MicCapture {
    private let engine = AVAudioEngine()
    private var pcm16 = Data()
    private var exportedSamples = 0
    private let lock = NSLock()
    // Guards running and the engine/tap setup, which a device change redoes
    // from another thread mid-call.
    private let stateLock = NSLock()
    private let restartQueue = DispatchQueue(label: "net.sealme.audio.mic-restart")
    private var configObserver: NSObjectProtocol?
    private var tapInstalled = false
    private(set) var running = false

    /// A denied (or not yet answered) Microphone prompt doesn't stop the
    /// engine from starting; the tap just gets silence, so the rep's side of
    /// the call would go missing without any error.
    static func hasPermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .audio)
        default:
            return false
        }
    }

    /// 0 on success, otherwise the error code sealme_audio_start returns.
    func start() -> Int32 {
        stateLock.lock()
        defer { stateLock.unlock() }

        // A tap left installed by a session that didn't shut down cleanly
        // would make the installTap below throw, which crashes the app.
        stopObservingDeviceChanges()
        stopEngine()
        lock.lock()
        pcm16 = Data()
        exportedSamples = 0
        lock.unlock()

        let code = installTapAndStart()
        guard code == 0 else { return code }
        running = true
        // The engine stops itself when the input device changes mid-call
        // (AirPods or a USB headset plugged in or out), and nothing would
        // start it again.
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.restartQueue.async { self?.restartAfterDeviceChange() }
        }
        return 0
    }

    private func restartAfterDeviceChange() {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard running else { return }
        stopEngine()
        // Stays silent until the next change brings a usable input back.
        _ = installTapAndStart()
    }

    private func stopObservingDeviceChanges() {
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
    }

    private func stopEngine() {
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if engine.isRunning {
            engine.stop()
        }
    }

    private func installTapAndStart() -> Int32 {
        guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: captureSampleRate, channels: 1, interleaved: true) else {
            return -3
        }

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.channelCount >= 1, inputFormat.sampleRate > 0 else { return -3 }

        // A real microphone is always 1-2 channels. Anything else means the
        // system's default input device is actually some virtual/aggregate
        // device (e.g. BlackHole set as the default input) rather than a mic.
        // Fail cleanly instead of silently mixing garbage into the call.
        guard inputFormat.channelCount <= 2 else { return -5 }
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else { return -3 }

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            let ratio = targetFormat.sampleRate / inputFormat.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
            guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

            var consumed = false
            var conversionError: NSError?
            converter.convert(to: outBuffer, error: &conversionError) { _, outStatus in
                if consumed {
                    outStatus.pointee = .noDataNow
                    return nil
                }
                consumed = true
                outStatus.pointee = .haveData
                return buffer
            }
            guard conversionError == nil, let channelData = outBuffer.int16ChannelData else { return }

            let frameLength = Int(outBuffer.frameLength)
            guard frameLength > 0 else { return }
            let data = Data(bytes: channelData[0], count: frameLength * MemoryLayout<Int16>.size)
            self.lock.lock()
            self.pcm16.append(data)
            self.lock.unlock()
        }
        tapInstalled = true

        do {
            engine.prepare()
            try engine.start()
            return 0
        } catch {
            input.removeTap(onBus: 0)
            tapInstalled = false
            return -3
        }
    }

    var sampleCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pcm16.count / MemoryLayout<Int16>.size
    }

    func stopAndGet() -> Data {
        stateLock.lock()
        stopObservingDeviceChanges()
        stopEngine()
        running = false
        stateLock.unlock()

        lock.lock()
        let result = pcm16
        pcm16 = Data()
        lock.unlock()
        return result
    }

    /// Returns only what's arrived since the last snapshot (or start), and
    /// advances the checkpoint — non-destructive otherwise, capture keeps
    /// running. Used for periodic live transcription passes so each pass
    /// only pays for new audio instead of re-transcribing the whole call.
    func snapshotDelta() -> Data {
        lock.lock()
        defer { lock.unlock() }
        let totalSamples = pcm16.count / MemoryLayout<Int16>.size
        guard totalSamples > exportedSamples else { return Data() }
        let delta = pcm16.suffix(from: exportedSamples * MemoryLayout<Int16>.size)
        exportedSamples = totalSamples
        return delta
    }
}

// MARK: - System audio + mic orchestration

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = CaptureSession()

    private var stream: SCStream?
    private var systemPcm16 = Data()
    private var systemExportedSamples = 0
    private let lock = NSLock()
    private(set) var capturing = false
    private let mic = MicCapture()

    func start() -> Int32 {
        if capturing { return -100 }

        systemPcm16 = Data()
        systemExportedSamples = 0

        let sem = DispatchSemaphore(value: 0)
        var result: Int32 = 0

        Task {
            guard await MicCapture.hasPermission() else {
                result = -4
                sem.signal()
                return
            }
            do {
                guard let newStream = try await self.makeStream() else {
                    result = -1
                    sem.signal()
                    return
                }
                try await newStream.startCapture()

                let micResult = self.mic.start()
                guard micResult == 0 else {
                    try? await newStream.stopCapture()
                    result = micResult
                    sem.signal()
                    return
                }

                self.withState {
                    self.stream = newStream
                    self.capturing = true
                }
                result = 0
            } catch {
                result = -2
            }
            sem.signal()
        }

        sem.wait()
        return result
    }

    /// Audio comes from every app, not only what's on the display the filter
    /// names, so whichever display is there will do. nil when there's none.
    private func makeStream() async throws -> SCStream? {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { return nil }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        // 16kHz mono per side is plenty for speech transcription and
        // keeps a 30-minute call under ~110MB instead of ~660MB at
        // 48kHz stereo per side.
        config.sampleRate = Int(captureSampleRate)
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let newStream = SCStream(filter: filter, configuration: config, delegate: self)
        try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "net.sealme.audio.capture"))
        return newStream
    }

    // stream and capturing change from the caller's thread, from start's
    // Task, and from ScreenCaptureKit's queue when it ends a stream itself.
    private func withState<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func stopAndGetWav() -> Data? {
        let (wasCapturing, activeStream) = withState { () -> (Bool, SCStream?) in
            let state = (self.capturing, self.stream)
            self.capturing = false
            self.stream = nil
            return state
        }

        if let activeStream {
            let sem = DispatchSemaphore(value: 0)
            Task {
                try? await activeStream.stopCapture()
                sem.signal()
            }
            sem.wait()
        }
        // Even with no session running: the mic must never be left on, tap
        // and all, into the next call.
        let micSamples = mic.stopAndGet()

        lock.lock()
        let sysSamples = systemPcm16
        systemPcm16 = Data()
        lock.unlock()

        guard wasCapturing, !sysSamples.isEmpty || !micSamples.isEmpty else { return nil }
        return CaptureSession.makeStereoWavFile(systemPcm: sysSamples, micPcm: micSamples, sampleRate: UInt32(captureSampleRate))
    }

    /// Non-destructive: returns only the audio captured since the last
    /// snapshot (or since start), on both channels, and advances the
    /// checkpoint. Capture keeps running — used for periodic live
    /// transcription passes during the call, mirroring how the Recall bot
    /// flow updates deal terms live instead of only at the very end.
    func snapshotDeltaWav() -> Data? {
        guard capturing else { return nil }

        lock.lock()
        let totalSamples = systemPcm16.count / MemoryLayout<Int16>.size
        let sysDelta: Data
        if totalSamples > systemExportedSamples {
            sysDelta = systemPcm16.suffix(from: systemExportedSamples * MemoryLayout<Int16>.size)
            systemExportedSamples = totalSamples
        } else {
            sysDelta = Data()
        }
        lock.unlock()

        let micDelta = mic.snapshotDelta()
        guard !sysDelta.isEmpty || !micDelta.isEmpty else { return nil }
        return CaptureSession.makeStereoWavFile(systemPcm: sysDelta, micPcm: micDelta, sampleRate: UInt32(captureSampleRate))
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio else { return }
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)
        guard status == noErr, let rawPointer = dataPointer, length > 0 else { return }

        // ScreenCaptureKit delivers interleaved Float32 PCM — convert to
        // Int16 for a small, universally-supported WAV file.
        let floatCount = length / MemoryLayout<Float32>.size
        rawPointer.withMemoryRebound(to: Float32.self, capacity: floatCount) { floatPtr in
            var int16Samples = [Int16](repeating: 0, count: floatCount)
            for i in 0..<floatCount {
                let clamped = max(-1.0, min(1.0, floatPtr[i]))
                int16Samples[i] = Int16(clamped * 32767.0)
            }
            lock.lock()
            int16Samples.withUnsafeBufferPointer { buf in
                systemPcm16.append(Data(buffer: buf))
            }
            lock.unlock()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // The system ended the stream itself: the display it was on got
        // unplugged, Screen Recording access was turned off, and so on. The
        // session stays open, so the mic keeps recording and what's already
        // captured still goes out with the next chunk and on stop.
        let isCurrent = withState { () -> Bool in
            guard self.capturing, self.stream === stream else { return false }
            self.stream = nil
            return true
        }
        guard isCurrent else { return }
        // Stopped by the user from the recording indicator in the menu bar:
        // they don't want the other side recorded anymore, so it stays off.
        if let scError = error as? SCStreamError, scError.code == .userStopped { return }
        Task { await self.restartSystemAudio() }
    }

    /// One try at a new stream. If none will start, the other side of the
    /// call is silence from here to the end.
    private func restartSystemAudio() async {
        do {
            if let newStream = try await makeStream() {
                try await newStream.startCapture()
                if !adoptRestartedStream(newStream) {
                    try? await newStream.stopCapture()
                }
                return
            }
        } catch {}
        FileHandle.standardError.write(Data("[audio] system audio stopped mid-call and couldn't be restarted\n".utf8))
    }

    // False when the call ended while the new stream was starting.
    private func adoptRestartedStream(_ newStream: SCStream) -> Bool {
        let micSamples = mic.sampleCount
        return withState {
            guard self.capturing, self.stream == nil else { return false }
            self.stream = newStream
            // Silence for the gap, so both sides stay lined up in time.
            let missing = micSamples - self.systemPcm16.count / MemoryLayout<Int16>.size
            if missing > 0 {
                self.systemPcm16.append(Data(count: missing * MemoryLayout<Int16>.size))
            }
            return true
        }
    }

    // MARK: - WAV encoding

    /// Interleaves two mono 16-bit PCM streams into a stereo WAV — left
    /// channel is system audio, right channel is the microphone. Whichever
    /// stream is shorter is padded with silence so lengths always match;
    /// small clock drift between the two independent capture pipelines is
    /// harmless here since Deepgram transcribes each channel on its own.
    static func makeStereoWavFile(systemPcm: Data, micPcm: Data, sampleRate: UInt32) -> Data {
        let sysCount = systemPcm.count / MemoryLayout<Int16>.size
        let micCount = micPcm.count / MemoryLayout<Int16>.size
        let totalSamples = max(sysCount, micCount)

        var interleaved = Data(capacity: totalSamples * 2 * MemoryLayout<Int16>.size)
        systemPcm.withUnsafeBytes { sysRaw in
            micPcm.withUnsafeBytes { micRaw in
                let sysSamples = sysRaw.bindMemory(to: Int16.self)
                let micSamples = micRaw.bindMemory(to: Int16.self)
                for i in 0..<totalSamples {
                    let s: Int16 = i < sysSamples.count ? sysSamples[i] : 0
                    let m: Int16 = i < micSamples.count ? micSamples[i] : 0
                    interleaved.appendLE(UInt16(bitPattern: s))
                    interleaved.appendLE(UInt16(bitPattern: m))
                }
            }
        }

        return makeWavFile(pcm16: interleaved, sampleRate: sampleRate, channels: 2)
    }

    static func makeWavFile(pcm16: Data, sampleRate: UInt32, channels: UInt16) -> Data {
        let bitsPerSample: UInt16 = 16
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let dataSize = UInt32(pcm16.count)
        let riffChunkSize = 36 + dataSize

        var file = Data()
        file.append(contentsOf: "RIFF".utf8)
        file.appendLE(riffChunkSize)
        file.append(contentsOf: "WAVE".utf8)
        file.append(contentsOf: "fmt ".utf8)
        file.appendLE(UInt32(16))
        file.appendLE(UInt16(1)) // PCM
        file.appendLE(channels)
        file.appendLE(sampleRate)
        file.appendLE(byteRate)
        file.appendLE(blockAlign)
        file.appendLE(bitsPerSample)
        file.append(contentsOf: "data".utf8)
        file.appendLE(dataSize)
        file.append(pcm16)
        return file
    }
}

// MARK: - C ABI

@_cdecl("sealme_audio_start")
public func sealme_audio_start() -> Int32 {
    CaptureSession.shared.start()
}

@_cdecl("sealme_audio_is_capturing")
public func sealme_audio_is_capturing() -> Int32 {
    CaptureSession.shared.capturing ? 1 : 0
}

@_cdecl("sealme_audio_stop_wav")
public func sealme_audio_stop_wav(_ outPtr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>) -> Int32 {
    guard let wav = CaptureSession.shared.stopAndGetWav() else {
        outPtr.pointee = nil
        outLen.pointee = 0
        return -1
    }
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: wav.count)
    wav.copyBytes(to: buffer, count: wav.count)
    outPtr.pointee = buffer
    outLen.pointee = wav.count
    return 0
}

@_cdecl("sealme_audio_free")
public func sealme_audio_free(_ ptr: UnsafeMutablePointer<UInt8>?, _ len: Int) {
    ptr?.deallocate()
}

@_cdecl("sealme_audio_snapshot_wav")
public func sealme_audio_snapshot_wav(_ outPtr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ outLen: UnsafeMutablePointer<Int>) -> Int32 {
    guard let wav = CaptureSession.shared.snapshotDeltaWav() else {
        outPtr.pointee = nil
        outLen.pointee = 0
        return -1
    }
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: wav.count)
    wav.copyBytes(to: buffer, count: wav.count)
    outPtr.pointee = buffer
    outLen.pointee = wav.count
    return 0
}
