// Apple's on-device speech engine for Sage dictation, behind a small C
// interface that src/speech_apple.zig loads with dlopen.
//
// This builds as libSageSpeech.dylib for macOS 26 and later. It is never linked
// into the Sage executable, whose minimum macOS is 11. On an older Mac the
// loader refuses the library and Sage hides the mic.
//
// Audio comes in as 16 kHz mono Int16 and is never written anywhere. Text goes
// out through one callback and is never logged.
//
// Sage's own copies of the audio are zeroed once they are used: the queue
// copies, the converter's temporary, and the buffers handed to the analyzer
// (the last minute of them at session end). Whatever SpeechAnalyzer and the
// system keep inside themselves is theirs, and out of this file's reach.
//
// Every function is safe to call from any thread, except that `begin` hands
// back a handle that one caller owns: feed, finish, cancel, and free for the
// same handle must not run at the same time.

import AVFoundation
import CoreMedia
import Foundation
import Speech

// MARK: - The C interface

/// Kinds the result callback reports.
///   1  grey text: the whole tail that is not final yet (replaces the last one)
///   2  final text: settled, appended
///   3  ended: the input finished and everything settled
///   4  failed: the engine stopped and will report nothing more
public typealias SageSpeechResultFn = @convention(c) (
  UnsafeMutableRawPointer?, Int32, UnsafePointer<UInt8>?, Int32
) -> Void

/// Bump when the interface changes. Sage refuses a library with another number.
private let abiVersion: Int32 = 2

@_cdecl("sage_speech_abi_version")
public func sage_speech_abi_version() -> Int32 {
  abiVersion
}

/// Model states reported by `sage_speech_status`:
///   0 checking (macOS has not said yet), 1 installed, 2 missing,
///   3 downloading, 4 failed, 5 no English model on this Mac
/// The fraction is 0...1 while downloading and -1 otherwise. The message is
/// UTF-8 for a failure and empty otherwise. Returns the message length.
/// It answers from a cache at once and never waits for macOS.
@_cdecl("sage_speech_status")
public func sage_speech_status(
  _ state: UnsafeMutablePointer<Int32>?,
  _ fraction: UnsafeMutablePointer<Double>?,
  _ message: UnsafeMutablePointer<UInt8>?,
  _ capacity: Int32
) -> Int32 {
  let snapshot = ModelState.shared.snapshot()
  state?.pointee = snapshot.state
  fraction?.pointee = snapshot.fraction
  guard let message, capacity > 0 else { return 0 }
  let bytes = Array(snapshot.message.utf8.prefix(Int(capacity)))
  for (index, byte) in bytes.enumerated() { message[index] = byte }
  return Int32(bytes.count)
}

/// Start downloading the speech model. Returns 1 when a download started and
/// 0 when there is nothing to do (still checking, installed, downloading, or
/// no English model on this Mac). It never waits for macOS.
@_cdecl("sage_speech_install")
public func sage_speech_install() -> Int32 {
  ModelState.shared.startInstall() ? 1 : 0
}

/// Open a session. Audio can be fed at once, before the engine is ready.
@_cdecl("sage_speech_begin")
public func sage_speech_begin(
  _ callback: SageSpeechResultFn?,
  _ context: UnsafeMutableRawPointer?
) -> UnsafeMutableRawPointer? {
  guard let callback else { return nil }
  let session = Session(callback: callback, context: context)
  session.start()
  return Unmanaged.passRetained(session).toOpaque()
}

@_cdecl("sage_speech_feed")
public func sage_speech_feed(
  _ handle: UnsafeMutableRawPointer?,
  _ samples: UnsafePointer<Int16>?,
  _ count: Int32
) {
  guard let handle, let samples, count > 0 else { return }
  let session = Unmanaged<Session>.fromOpaque(handle).takeUnretainedValue()
  session.feed(UnsafeBufferPointer(start: samples, count: Int(count)))
}

/// No more audio. The engine settles what it heard, reports the last final text,
/// then reports `ended`.
@_cdecl("sage_speech_finish")
public func sage_speech_finish(_ handle: UnsafeMutableRawPointer?) {
  guard let handle else { return }
  Unmanaged<Session>.fromOpaque(handle).takeUnretainedValue().finish()
}

/// Stop at once. The engine reports nothing more after this returns.
@_cdecl("sage_speech_cancel")
public func sage_speech_cancel(_ handle: UnsafeMutableRawPointer?) {
  guard let handle else { return }
  Unmanaged<Session>.fromOpaque(handle).takeUnretainedValue().cancel()
}

/// Release the handle. No callback is running or will run once this returns.
@_cdecl("sage_speech_free")
public func sage_speech_free(_ handle: UnsafeMutableRawPointer?) {
  guard let handle else { return }
  let unmanaged = Unmanaged<Session>.fromOpaque(handle)
  let session = unmanaged.takeUnretainedValue()
  session.cancel()
  session.close()
  unmanaged.release()
}

// MARK: - The speech model

/// Use the Mac's own locale when it is English and supported, else US English.
private func englishLocale() async -> Locale? {
  let current = Locale.current
  if current.language.languageCode?.identifier == "en",
    let supported = await SpeechTranscriber.supportedLocale(equivalentTo: current)
  {
    return supported
  }
  return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US"))
}

/// Speech mode with grey text and fast results. Without fast results the
/// transcriber works in windows of about 4 s, too slow for dictation.
private func makeTranscriber(locale: Locale) -> SpeechTranscriber {
  SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [.volatileResults, .fastResults],
    attributeOptions: [.audioTimeRange])
}

/// What the OS knows about the model, kept fresh in the background so a status
/// call never waits on the OS. Until macOS answers the first time, the state
/// is 0 (checking).
private final class ModelState: @unchecked Sendable {
  static let shared = ModelState()

  struct Snapshot {
    var state: Int32
    var fraction: Double
    var message: String
  }

  private let gate = NSLock()
  private var state: Int32 = 0  // 0: macOS has not answered yet
  private var fraction: Double = -1
  private var message = ""
  private var installing = false
  private var refreshing = false
  private var lastRefresh: ContinuousClock.Instant?

  /// The cached answer, at once. It starts a refresh in the background when
  /// the answer is old.
  func snapshot() -> Snapshot {
    refreshIfStale()
    return gate.withLock { Snapshot(state: state, fraction: fraction, message: message) }
  }

  private func refreshIfStale() {
    gate.lock()
    if refreshing || installing {
      gate.unlock()
      return
    }
    if let last = lastRefresh, ContinuousClock.now - last < .seconds(5) {
      gate.unlock()
      return
    }
    refreshing = true
    gate.unlock()
    Task(priority: .utility) { await self.refresh() }
  }

  private func refresh() async {
    var next: Int32 = 5
    if let locale = await englishLocale() {
      // `AssetInventory.status` reads `supported` for a model that is installed
      // until this process has reserved its locale, so ask for the installed
      // locales first.
      let wanted = locale.identifier(.bcp47)
      let installed = await SpeechTranscriber.installedLocales
      if installed.contains(where: { $0.identifier(.bcp47) == wanted }) {
        next = 1
      } else {
        let status = await AssetInventory.status(forModules: [makeTranscriber(locale: locale)])
        switch status {
        case .installed: next = 1
        case .supported: next = 2
        case .downloading: next = 3
        case .unsupported: next = 5
        @unknown default: next = 2
        }
      }
    }
    gate.withLock {
      refreshing = false
      lastRefresh = ContinuousClock.now
      // A failed download keeps its message until the next attempt or an install.
      if !installing && !(state == 4 && next != 1) {
        state = next
        if next != 3 { fraction = -1 }
        if next == 1 || next == 5 { message = "" }
      }
    }
  }

  func startInstall() -> Bool {
    refreshIfStale()
    gate.lock()
    // Nothing to download until macOS has said what is installed.
    if installing || state == 0 || state == 1 || state == 5 {
      gate.unlock()
      return false
    }
    installing = true
    state = 3
    fraction = 0
    message = ""
    gate.unlock()
    Task(priority: .utility) { await self.install() }
    return true
  }

  private func install() async {
    do {
      guard let locale = await englishLocale() else {
        finishInstall(state: 5, message: "")
        return
      }
      let module = makeTranscriber(locale: locale)
      guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module])
      else {
        finishInstall(state: 1, message: "")
        return
      }
      let poll = Task {
        while !Task.isCancelled {
          let value = request.progress.fractionCompleted
          self.setFraction(value.isFinite ? min(max(value, 0), 1) : 0)
          try? await Task.sleep(nanoseconds: 300_000_000)
        }
      }
      defer { poll.cancel() }
      try await request.downloadAndInstall()
      finishInstall(state: 1, message: "")
    } catch {
      finishInstall(
        state: 4, message: "The speech model did not download. Check your connection and try again.")
    }
  }

  private func setFraction(_ value: Double) {
    gate.withLock {
      if installing { fraction = value }
    }
  }

  private func finishInstall(state next: Int32, message text: String) {
    gate.withLock {
      installing = false
      state = next
      fraction = -1
      message = text
      lastRefresh = ContinuousClock.now
    }
  }
}

// MARK: - A dictation session

/// Audio waiting for the analyzer is capped at about a minute, the same as the
/// ring on Sage's side. Past that the analyzer has stalled, and the session
/// reports a failure instead of piling up audio that would arrive far too late.
private let maxQueuedSamples = 16_000 * 60

/// The most recent buffers kept after they went to the analyzer, in seconds of
/// audio. Older ones are zeroed as they leave. The rest are zeroed at the end.
private let trailSeconds = 60.0

/// Zero memory in a way the optimizer may not drop.
private func scrub(_ pointer: UnsafeMutableRawPointer?, _ byteCount: Int) {
  guard let pointer, byteCount > 0 else { return }
  memset_s(pointer, byteCount, 0, byteCount)
}

private func scrub(_ buffer: AVAudioPCMBuffer) {
  for audio in UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList) {
    scrub(audio.mData, Int(audio.mDataByteSize))
  }
}

/// A copy of the samples Sage fed, zeroed when the last reference goes.
private final class AudioChunk: @unchecked Sendable {
  let samples: UnsafeMutablePointer<Int16>
  let count: Int

  init(copying source: UnsafeBufferPointer<Int16>) {
    count = source.count
    samples = UnsafeMutablePointer<Int16>.allocate(capacity: max(count, 1))
    if let base = source.baseAddress { samples.update(from: base, count: count) }
  }

  deinit {
    scrub(samples, count * MemoryLayout<Int16>.size)
    samples.deallocate()
  }
}

/// Hands the queued chunks to the analyzer one at a time, as it asks for them.
private final class ChunkSource: @unchecked Sendable {
  private var iterator: AsyncStream<AudioChunk>.AsyncIterator

  init(_ stream: AsyncStream<AudioChunk>) {
    iterator = stream.makeAsyncIterator()
  }

  func next() async -> AudioChunk? {
    await iterator.next()
  }
}

/// Turns the 16 kHz mono Int16 samples Sage captures into the buffers the
/// analyzer wants. The analyzer reports 16 kHz mono Int16 on the Macs tested,
/// which needs no conversion. Any other format goes through AVAudioConverter.
private final class SampleConverter: @unchecked Sendable {
  private let target: AVAudioFormat
  private let source: AVAudioFormat
  private let converter: AVAudioConverter?

  init?(target: AVAudioFormat) {
    guard
      let source = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)
    else { return nil }
    self.target = target
    self.source = source
    let direct =
      target.commonFormat == .pcmFormatInt16 && target.sampleRate == 16_000
      && target.channelCount == 1
    if direct {
      converter = nil
    } else {
      guard let made = AVAudioConverter(from: source, to: target) else { return nil }
      converter = made
    }
  }

  func buffer(from chunk: AudioChunk) -> AVAudioPCMBuffer? {
    let frames = AVAudioFrameCount(chunk.count)
    guard frames > 0,
      let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames),
      let channel = input.int16ChannelData
    else { return nil }
    input.frameLength = frames
    channel[0].update(from: chunk.samples, count: chunk.count)
    guard let converter else { return input }

    // From here the input is only a temporary, so it is zeroed once converted.
    defer { scrub(input) }
    let ratio = target.sampleRate / source.sampleRate
    let capacity = AVAudioFrameCount(Double(frames) * ratio) + 64
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
      return nil
    }
    var handedOver = false
    var failure: NSError?
    let status = converter.convert(to: output, error: &failure) { _, inputStatus in
      if handedOver {
        inputStatus.pointee = .noDataNow
        return nil
      }
      handedOver = true
      inputStatus.pointee = .haveData
      return input
    }
    if status == .error || output.frameLength == 0 { return nil }
    return output
  }
}

private final class Session: @unchecked Sendable {
  private let callback: SageSpeechResultFn
  private let context: UnsafeMutableRawPointer?
  private let input: AsyncStream<AudioChunk>
  private let inputContinuation: AsyncStream<AudioChunk>.Continuation
  /// Finishes when the analyzer has been given all the input, or the session
  /// is cancelled.
  private let inputDone: AsyncStream<Void>
  private let inputDoneContinuation: AsyncStream<Void>.Continuation

  /// Guards the flags below and every call out to Sage, so `close` can promise
  /// that no callback is running or will run after it returns.
  private let gate = NSLock()
  private var closed = false
  private var cancelRequested = false
  private var finished = false
  private var analyzer: SpeechAnalyzer?
  private var task: Task<Void, Never>?

  /// Guards the audio bookkeeping: the samples queued for the analyzer, and the
  /// buffers it was given most recently.
  private let audioGate = NSLock()
  private var queuedSamples = 0
  private var trail: [AVAudioPCMBuffer] = []
  private var trailLength = 0.0

  init(callback: @escaping SageSpeechResultFn, context: UnsafeMutableRawPointer?) {
    self.callback = callback
    self.context = context
    (input, inputContinuation) = AsyncStream<AudioChunk>.makeStream(bufferingPolicy: .unbounded)
    (inputDone, inputDoneContinuation) = AsyncStream<Void>.makeStream()
  }

  deinit {
    scrubTrail()
  }

  func start() {
    task = Task(priority: .userInitiated) { await self.run() }
  }

  func feed(_ samples: UnsafeBufferPointer<Int16>) {
    let stalled = audioGate.withLock { () -> Bool in
      queuedSamples += samples.count
      return queuedSamples > maxQueuedSamples
    }
    if stalled {
      // The analyzer is a minute behind. Say so, and stop taking audio.
      emit(4, "")
      cancel()
      return
    }
    inputContinuation.yield(AudioChunk(copying: samples))
  }

  func finish() {
    inputContinuation.finish()
  }

  func cancel() {
    gate.lock()
    let already = cancelRequested
    cancelRequested = true
    let active = finished ? nil : analyzer
    gate.unlock()
    if already { return }
    inputContinuation.finish()
    inputDoneContinuation.finish()
    task?.cancel()
    if let active {
      Task { await active.cancelAndFinishNow() }
    }
  }

  func close() {
    gate.lock()
    closed = true
    gate.unlock()
  }

  /// Calls Sage while holding the gate. Sage's callback only queues the text
  /// and wakes its event loop, so it never waits on anything.
  private func emit(_ kind: Int32, _ text: String) {
    gate.lock()
    defer { gate.unlock() }
    if closed || cancelRequested { return }
    var bytes = Array(text.utf8)
    bytes.withUnsafeMutableBufferPointer { buffer in
      callback(context, kind, UnsafePointer(buffer.baseAddress), Int32(buffer.count))
    }
  }

  private func isCancelled() -> Bool {
    gate.withLock { cancelRequested }
  }

  /// The next buffer for the analyzer, made when it asks. Taking a chunk off
  /// the queue is what counts it as used, so a stalled analyzer shows as a
  /// queue that only grows.
  private func nextInput(_ source: ChunkSource, _ converter: SampleConverter) async
    -> AnalyzerInput?
  {
    while let chunk = await source.next() {
      audioGate.withLock { queuedSamples -= chunk.count }
      if isCancelled() { break }
      if let buffer = converter.buffer(from: chunk) {
        remember(buffer)
        return AnalyzerInput(buffer: buffer)
      }
    }
    inputDoneContinuation.finish()
    return nil
  }

  /// Keeps the last minute of buffers the analyzer was given, so they can be
  /// zeroed. A buffer that falls out of that minute is zeroed at once.
  private func remember(_ buffer: AVAudioPCMBuffer) {
    var expired: [AVAudioPCMBuffer] = []
    audioGate.withLock {
      trail.append(buffer)
      trailLength += duration(of: buffer)
      while trailLength > trailSeconds, let oldest = trail.first {
        trail.removeFirst()
        trailLength -= duration(of: oldest)
        expired.append(oldest)
      }
    }
    for old in expired { scrub(old) }
  }

  private func duration(of buffer: AVAudioPCMBuffer) -> Double {
    Double(buffer.frameLength) / buffer.format.sampleRate
  }

  private func scrubTrail() {
    let kept = audioGate.withLock { () -> [AVAudioPCMBuffer] in
      let kept = trail
      trail = []
      trailLength = 0
      return kept
    }
    for buffer in kept { scrub(buffer) }
  }

  private func run() async {
    defer {
      gate.withLock { finished = true }
      scrubTrail()
    }
    do {
      guard let locale = await englishLocale() else {
        emit(4, "")
        return
      }
      let transcriber = makeTranscriber(locale: locale)
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      guard
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
        let converter = SampleConverter(target: format)
      else {
        emit(4, "")
        return
      }
      let cancelled = gate.withLock { () -> Bool in
        self.analyzer = analyzer
        return cancelRequested
      }
      if cancelled {
        await analyzer.cancelAndFinishNow()
        return
      }

      try await analyzer.prepareToAnalyze(in: format)
      let results = Task {
        for try await result in transcriber.results {
          self.emit(result.isFinal ? 2 : 1, String(result.text.characters))
        }
      }
      let source = ChunkSource(input)
      let analyzerInput = AsyncStream<AnalyzerInput> {
        await self.nextInput(source, converter)
      }
      try await analyzer.start(inputSequence: analyzerInput)

      // The analyzer pulls the input itself. This returns when it has been
      // given all of it, or when the session is cancelled.
      for await _ in inputDone {}
      if isCancelled() {
        results.cancel()
        await analyzer.cancelAndFinishNow()
        return
      }
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      try await results.value
      emit(3, "")
    } catch {
      emit(4, "")
    }
  }
}
