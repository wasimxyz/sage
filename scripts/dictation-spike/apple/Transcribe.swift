// Feeds a WAV file to Apple's SpeechAnalyzer the way a live microphone would,
// and writes one JSON line per result. Part of the dictation voice test; see
// ../README.md.
//
//   transcribe-apple install
//   transcribe-apple run --input clip.wav --out events.jsonl [--model speech|dictation] [--fast]
//
// Two of Apple's modules can give live text:
//   speech     SpeechTranscriber with volatile and fast results. Without fast
//              results it works through audio in windows of about 4 s, too
//              slow for dictation.
//   dictation  DictationTranscriber with volatile results, punctuation, and
//              frequent finalization.
//
// Without --fast, audio is fed in 100 ms buffers at real-time speed, so the
// timings in the log match what a person would see while talking.

import AVFoundation
import CoreMedia
import Foundation
import Speech

enum SpikeError: Error, CustomStringConvertible {
  case message(String)
  var description: String {
    switch self {
    case .message(let text): return text
    }
  }
}

final class EventLog: @unchecked Sendable {
  private let handle: FileHandle
  private let lock = NSLock()

  init(path: String) throws {
    guard FileManager.default.createFile(atPath: path, contents: nil),
      let handle = FileHandle(forWritingAtPath: path)
    else { throw SpikeError.message("Could not create \(path)") }
    self.handle = handle
  }

  func write(_ object: [String: Any]) {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    else { return }
    lock.lock()
    defer { lock.unlock() }
    handle.write(data)
    handle.write(Data([0x0a]))
  }

  func close() {
    lock.lock()
    defer { lock.unlock() }
    try? handle.close()
  }
}

struct Options {
  var command = ""
  var input = ""
  var out = ""
  var fast = false
  var locale = "en-US"
  var model = "speech"
}

func parseOptions() throws -> Options {
  var options = Options()
  var args = Array(CommandLine.arguments.dropFirst())
  guard !args.isEmpty else {
    throw SpikeError.message(
      "usage: transcribe-apple install | run --input WAV --out JSONL [--model speech|dictation] [--fast]")
  }
  options.command = args.removeFirst()
  while !args.isEmpty {
    let flag = args.removeFirst()
    switch flag {
    case "--fast": options.fast = true
    case "--input", "--out", "--locale", "--model":
      guard !args.isEmpty else { throw SpikeError.message("\(flag) needs a value") }
      let value = args.removeFirst()
      if flag == "--input" { options.input = value }
      if flag == "--out" { options.out = value }
      if flag == "--locale" { options.locale = value }
      if flag == "--model" {
        guard value == "speech" || value == "dictation" else {
          throw SpikeError.message("--model is speech or dictation")
        }
        options.model = value
      }
    default: throw SpikeError.message("Unknown option \(flag)")
    }
  }
  return options
}

func milliseconds(since start: ContinuousClock.Instant) -> Double {
  let elapsed = ContinuousClock.now - start
  return Double(elapsed.components.seconds) * 1000
    + Double(elapsed.components.attoseconds) / 1e15
}

func peakResidentBytes() -> Int {
  var usage = rusage()
  getrusage(RUSAGE_SELF, &usage)
  return Int(usage.ru_maxrss)  // bytes on macOS
}

/// The module under test, and a way to read its results as plain values.
enum Engine {
  case speech(SpeechTranscriber)
  case dictation(DictationTranscriber)

  static func make(_ model: String, locale identifier: String) async throws -> Engine {
    let wanted = Locale(identifier: identifier)
    if model == "dictation" {
      guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: wanted) else {
        throw SpikeError.message("DictationTranscriber does not support \(identifier) on this Mac")
      }
      return .dictation(
        DictationTranscriber(
          locale: locale,
          contentHints: [],
          transcriptionOptions: [.punctuation],
          reportingOptions: [.volatileResults, .frequentFinalization],
          attributeOptions: [.audioTimeRange]))
    }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
      throw SpikeError.message("SpeechTranscriber does not support \(identifier) on this Mac")
    }
    return .speech(
      SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: [.audioTimeRange]))
  }

  var module: any SpeechModule {
    switch self {
    case .speech(let transcriber): return transcriber
    case .dictation(let transcriber): return transcriber
    }
  }

  var name: String {
    switch self {
    case .speech: return "apple"
    case .dictation: return "apple-dictation"
    }
  }

  var locale: String {
    switch self {
    case .speech(let transcriber): return transcriber.selectedLocales.first?.identifier ?? ""
    case .dictation(let transcriber): return transcriber.selectedLocales.first?.identifier ?? ""
    }
  }

  /// Calls `record(isFinal, text, range)` for every result until the input ends.
  func readResults(_ record: @escaping @Sendable (Bool, String, CMTimeRange) -> Void) -> Task<Void, Error> {
    switch self {
    case .speech(let transcriber):
      return Task {
        for try await result in transcriber.results {
          record(result.isFinal, String(result.text.characters), result.range)
        }
      }
    case .dictation(let transcriber):
      return Task {
        for try await result in transcriber.results {
          record(result.isFinal, String(result.text.characters), result.range)
        }
      }
    }
  }
}

/// Downloads the on-device model for this locale if the OS does not have it.
/// Returns true when it had to download.
func installAssets(for module: any SpeechModule) async throws -> Bool {
  guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module])
  else { return false }
  try await request.downloadAndInstall()
  return true
}

/// Reads the whole file and converts it to the analyzer's format up front, so
/// conversion time never counts against the real-time feed.
func readAudio(path: String, as format: AVAudioFormat) throws -> AVAudioPCMBuffer {
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
  let sourceFormat = file.processingFormat
  guard
    let source = AVAudioPCMBuffer(
      pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(file.length))
  else { throw SpikeError.message("Could not allocate a buffer for \(path)") }
  try file.read(into: source)
  if sourceFormat == format { return source }

  guard let converter = AVAudioConverter(from: sourceFormat, to: format) else {
    throw SpikeError.message("Cannot convert \(sourceFormat) to \(format)")
  }
  let ratio = format.sampleRate / sourceFormat.sampleRate
  let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 4096
  guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
    throw SpikeError.message("Could not allocate the converted buffer")
  }
  var handedOver = false
  var conversionError: NSError?
  let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
    if handedOver {
      inputStatus.pointee = .endOfStream
      return nil
    }
    handedOver = true
    inputStatus.pointee = .haveData
    return source
  }
  if status == .error {
    throw conversionError ?? SpikeError.message("Audio conversion failed")
  }
  return output
}

/// Copies frames [start, start + count) into a new buffer.
func slice(_ buffer: AVAudioPCMBuffer, start: AVAudioFrameCount, count: AVAudioFrameCount)
  throws -> AVAudioPCMBuffer
{
  guard let output = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: count) else {
    throw SpikeError.message("Could not allocate a slice")
  }
  output.frameLength = count
  let bytesPerFrame = Int(buffer.format.streamDescription.pointee.mBytesPerFrame)
  let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
  let destination = UnsafeMutableAudioBufferListPointer(output.mutableAudioBufferList)
  for index in 0..<source.count {
    guard let from = source[index].mData, let to = destination[index].mData else { continue }
    memcpy(to, from.advanced(by: Int(start) * bytesPerFrame), Int(count) * bytesPerFrame)
    destination[index].mDataByteSize = UInt32(Int(count) * bytesPerFrame)
  }
  return output
}

func install(_ options: Options) async throws {
  for model in ["speech", "dictation"] {
    let engine = try await Engine.make(model, locale: options.locale)
    let downloaded = try await installAssets(for: engine.module)
    print("{\"engine\":\"\(engine.name)\",\"locale\":\"\(engine.locale)\",\"downloaded\":\(downloaded)}")
  }
}

func run(_ options: Options) async throws {
  guard !options.input.isEmpty, !options.out.isEmpty else {
    throw SpikeError.message("run needs --input and --out")
  }
  let engine = try await Engine.make(options.model, locale: options.locale)
  _ = try await installAssets(for: engine.module)

  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [engine.module])
  else { throw SpikeError.message("No audio format works with \(engine.name)") }
  let audio = try readAudio(path: options.input, as: format)
  let audioMs = Double(audio.frameLength) / format.sampleRate * 1000

  let log = try EventLog(path: options.out)
  let analyzer = SpeechAnalyzer(modules: [engine.module])

  // Sage would do this when you press the mic, before you start talking.
  let prepareStart = ContinuousClock.now
  try await analyzer.prepareToAnalyze(in: format)
  log.write([
    "kind": "meta", "engine": engine.name, "locale": engine.locale,
    "format": "\(format)", "mode": options.fast ? "fast" : "realtime",
    "audio_ms": audioMs, "prepare_ms": milliseconds(since: prepareStart),
  ])

  let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()
  let clockStart = ContinuousClock.now

  let results = engine.readResults { isFinal, text, range in
    var event: [String: Any] = [
      "kind": isFinal ? "final" : "volatile",
      "wall_ms": milliseconds(since: clockStart),
      "text": text,
    ]
    if range.isValid {
      event["audio_start_ms"] = range.start.seconds * 1000
      event["audio_end_ms"] = range.end.seconds * 1000
    }
    log.write(event)
  }

  try await analyzer.start(inputSequence: inputSequence)

  let chunkFrames = AVAudioFrameCount(format.sampleRate / 10)
  var offset: AVAudioFrameCount = 0
  while offset < audio.frameLength {
    let count = min(chunkFrames, audio.frameLength - offset)
    if !options.fast {
      // A buffer exists only once the mic has heard all of it.
      let dueMs = Double(offset + count) / format.sampleRate * 1000
      try await Task.sleep(
        until: clockStart.advanced(by: .microseconds(Int64(dueMs * 1000))), clock: .continuous)
    }
    inputBuilder.yield(AnalyzerInput(buffer: try slice(audio, start: offset, count: count)))
    offset += count
  }

  // Pressing Stop: no more audio, settle whatever is still grey.
  log.write(["kind": "input_end", "wall_ms": milliseconds(since: clockStart)])
  inputBuilder.finish()
  try await analyzer.finalizeAndFinishThroughEndOfInput()
  try await results.value
  log.write([
    "kind": "end", "wall_ms": milliseconds(since: clockStart),
    "peak_rss_bytes": peakResidentBytes(),
  ])
  log.close()
}

@main
struct Transcribe {
  static func main() async {
    do {
      let options = try parseOptions()
      switch options.command {
      case "install": try await install(options)
      case "run": try await run(options)
      default: throw SpikeError.message("Unknown command \(options.command)")
      }
    } catch {
      FileHandle.standardError.write(Data("transcribe-apple: \(error)\n".utf8))
      exit(1)
    }
  }
}
