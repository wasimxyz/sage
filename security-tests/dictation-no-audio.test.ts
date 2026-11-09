import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type Syntax = "swift" | "zig";

interface Rule {
  pattern: RegExp;
  why: string;
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(repoRoot, dir), {
    withFileTypes: true,
  })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        found.push(...filesUnder(path, extensions));
      }
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

// Drops comments and keeps string literals, so a sentence such as "never
// logged" in a comment cannot trip a rule, and a rule still sees every call.
// A quote ends at the end of its line, so one stray quote cannot swallow the
// rest of the file.
function stripComments(source: string, syntax: Syntax): string {
  let out = "";
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    const next = source[at + 1];
    if (char === "/" && next === "/") {
      while (at < source.length && source[at] !== "\n") {
        at += 1;
      }
      continue;
    }
    if (syntax === "swift" && char === "/" && next === "*") {
      let depth = 1;
      at += 2;
      while (at < source.length && depth > 0) {
        if (source.startsWith("/*", at)) {
          depth += 1;
          at += 2;
        } else if (source.startsWith("*/", at)) {
          depth -= 1;
          at += 2;
        } else {
          out += source[at] === "\n" ? "\n" : "";
          at += 1;
        }
      }
      continue;
    }
    if (syntax === "swift" && source.startsWith('"""', at)) {
      const end = source.indexOf('"""', at + 3);
      const stop = end === -1 ? source.length : end + 3;
      out += source.slice(at, stop);
      at = stop;
      continue;
    }
    if (char === '"' || (syntax === "zig" && char === "'")) {
      let end = at + 1;
      while (end < source.length && source[end] !== char) {
        if (source[end] === "\n") {
          break;
        }
        end += source[end] === "\\" ? 2 : 1;
      }
      out += source.slice(at, end + 1);
      at = end + 1;
      continue;
    }
    out += char;
    at += 1;
  }
  return out;
}

function violations(source: string, rules: readonly Rule[]): string[] {
  return rules
    .filter((rule) => rule.pattern.test(source))
    .map((rule) => rule.why);
}

const dictationZig = [
  "src/dictation.zig",
  "src/microphone.zig",
  "src/speech_apple.zig",
] as const;
const dictationSwift = "src/speech/SageSpeech.swift";

// Names that would put audio or recognition in the web view. `AudioContext`
// also matches `webkitAudioContext`, and `SpeechRecognition` also matches
// `webkitSpeechRecognition`, which sends audio to Apple's servers.
const webAudioNames = [
  "getUserMedia",
  "MediaRecorder",
  "AudioContext",
  "AudioWorklet",
  "SpeechRecognition",
] as const;

// Calls that create, change, or move a file. Reading a file, as the live test
// does with a WAV, and building a path are not here. `std.Io.Writer.fixed`
// writes to memory and is fine.
const zigFileWrites: readonly Rule[] = [
  {
    pattern:
      /\b(createFile|createFileAbsolute|writeFile|writeFileAlloc|atomicFile|createDir|createDirPath|createDirAbsolute|makeDir|makePath|rename|renameAbsolute|copyFile|symLink|openFile|openFileAbsolute|setLength|truncate|fopen|fwrite|creat)\b/,
    why: "creates, opens for writing, or moves a file",
  },
  {
    pattern:
      /\bO_(WRONLY|RDWR|CREAT|TRUNC|APPEND)\b|\.write_only\b|\.read_write\b/,
    why: "opens a file for writing",
  },
  {
    pattern: /\b(posix|c|os)\.(open|openat|write|pwrite|creat)\(/,
    why: "writes through a file descriptor",
  },
];

const swiftFileWrites: readonly Rule[] = [
  {
    pattern:
      /\b(FileManager|FileHandle|NSFileHandle|FileWrapper|AVAudioFile|OutputStream|NSKeyedArchiver|UserDefaults|NSTemporaryDirectory)\b/,
    why: "uses an API that writes files or settings",
  },
  {
    pattern: /\b(temporaryDirectory|createFile|fopen|fwrite|writeToFile)\b/,
    why: "creates or writes a file",
  },
  {
    pattern: /\.write\(\s*(to|toFile)\b/,
    why: "writes data to a path",
  },
];

// Transcript text is the person's own voice. Nothing here may print or log
// anything, and `speech_apple.zig` may print only numbers in its live test.
const zigLogging: readonly Rule[] = [
  {
    pattern: /\bstd\.log\b/,
    why: "calls std.log",
  },
  {
    pattern: /\bstd\.debug\.(print|dump\w*|lockStderr|getStderr\w*)\b/,
    why: "prints to stderr",
  },
  {
    pattern: /\bstd\.Io\.File\.stderr\b/,
    why: "writes to stderr",
  },
];

const swiftLogging: readonly Rule[] = [
  {
    pattern:
      /(?<![\w.])(print|debugPrint|dump|NSLog|os_log|fputs|fprintf|fputc)\(/,
    why: "prints or logs",
  },
  {
    pattern:
      /\b(Logger|OSLog|OSLogStore|standardError|stderr)\b|^\s*import\s+(os|OSLog)\b/m,
    why: "uses the system log or stderr",
  },
];

// Dictation talks to the OS and to the web view. It opens no connection, so
// neither audio nor text can leave through it.
const zigNetwork: readonly Rule[] = [
  {
    pattern: /\bstd\.(http|net)\b|\bstd\.Io\.net\b|\bsocket\(/,
    why: "opens a network connection",
  },
];

const swiftNetwork: readonly Rule[] = [
  {
    pattern:
      /\b(URLSession|URLRequest|NWConnection|NWListener|CFSocket|CFStream|WebSocket)\b|^\s*import\s+Network\b/m,
    why: "opens a network connection",
  },
];

function formatPlaceholders(source: string): string[] {
  const placeholders: string[] = [];
  for (const call of source.matchAll(
    /std\.debug\.print\(\s*"((?:[^"\\]|\\.)*)"/g
  )) {
    placeholders.push(...(call[1].match(/\{[^}]*\}/g) ?? []));
  }
  return placeholders;
}

test("the web view never opens the microphone or records audio", () => {
  const files = [
    ...filesUnder("frontend/src", [".ts", ".tsx", ".js", ".jsx", ".mjs"]),
    "frontend/index.html",
  ];
  assert.ok(
    files.length > 50,
    "found too few frontend files, so this check is reading the wrong folder."
  );
  for (const file of files) {
    const text = read(file);
    for (const name of webAudioNames) {
      assert.ok(
        !text.includes(name),
        `${file} uses ${name}. Audio is captured in the core and never reaches the web view, which only receives text. The mic prompt would also name the wrong thing.`
      );
    }
  }
});

test("the dictation sources write no files", () => {
  for (const file of dictationZig) {
    const found = violations(stripComments(read(file), "zig"), zigFileWrites);
    assert.deepEqual(
      found,
      [],
      `${file} ${found.join("; ")}. Audio and transcripts stay in memory.`
    );
  }
  const swift = violations(
    stripComments(read(dictationSwift), "swift"),
    swiftFileWrites
  );
  assert.deepEqual(
    swift,
    [],
    `${dictationSwift} ${swift.join("; ")}. Audio and transcripts stay in memory.`
  );
});

test("the dictation sources log no text and open no connection", () => {
  for (const file of dictationZig) {
    const code = stripComments(read(file), "zig");
    const found = violations(code, [...zigLogging, ...zigNetwork]).filter(
      // The live test in speech_apple.zig prints counts. See below.
      (why) => !(file === "src/speech_apple.zig" && why === "prints to stderr")
    );
    assert.deepEqual(
      found,
      [],
      `${file} ${found.join("; ")}. A transcript is the person's own voice.`
    );
    if (file === "src/speech_apple.zig") {
      // Each placeholder is a number. `{s}`, `{any}`, and `{f}` would print text.
      const placeholders = formatPlaceholders(code);
      assert.ok(
        placeholders.length > 0,
        "could not find the live test's print in speech_apple.zig, so this check reads nothing."
      );
      assert.deepEqual(
        placeholders.filter((placeholder) => placeholder !== "{d}"),
        [],
        "speech_apple.zig prints something other than a number. The live test may print sizes and counts only."
      );
    }
  }
  const swift = violations(stripComments(read(dictationSwift), "swift"), [
    ...swiftLogging,
    ...swiftNetwork,
  ]);
  assert.deepEqual(
    swift,
    [],
    `${dictationSwift} ${swift.join("; ")}. A transcript is the person's own voice.`
  );
});

test("the audio ring is zeroed before its memory is freed", () => {
  const dictation = stripComments(read("src/dictation.zig"), "zig");
  assert.match(
    dictation,
    /secureZero\(i16, self\.storage\)/,
    "Ring.clear no longer zeroes the audio, so a minute of speech could stay in freed memory."
  );
  const destroy = dictation.slice(
    dictation.indexOf("fn destroy(self: *Session)")
  );
  assert.ok(
    destroy.indexOf("self.ring.clear()") >= 0 &&
      destroy.indexOf("self.ring.clear()") <
        destroy.indexOf("page_allocator.free(storage)"),
    "Session.destroy frees the audio before it clears it."
  );
});

test("the microphone prompt is set before the app is signed", () => {
  const script = read("scripts/copy-agent-into-app.sh")
    .split("\n")
    .map((line, index) => ({ index, text: line.trim() }))
    .filter(({ text }) => text !== "" && !text.startsWith("#"));
  const lineOf = (needle: string) =>
    script.find(({ text }) => text.includes(needle))?.index ?? -1;
  const plist = lineOf("PlistBuddy");
  const library = lineOf("Frameworks/libSageSpeech.dylib");
  const sign = lineOf("codesign");
  assert.ok(
    plist >= 0,
    "copy-agent-into-app.sh no longer sets the microphone text with PlistBuddy, so the packaged prompt keeps the Native SDK's wording."
  );
  assert.ok(
    library >= 0,
    "copy-agent-into-app.sh no longer copies libSageSpeech.dylib into Contents/Frameworks."
  );
  assert.ok(
    sign >= 0,
    "copy-agent-into-app.sh no longer signs the app, so the copied files break its seal."
  );
  assert.ok(
    plist < sign,
    "copy-agent-into-app.sh edits Info.plist after codesign, which breaks the seal and macOS refuses the app."
  );
  assert.ok(
    library < sign,
    "copy-agent-into-app.sh copies the speech library after codesign, so it ships unsigned inside a signed bundle."
  );
});

test("the dev and packaged builds ask for the microphone in the same words", () => {
  const sentence = read("build.zig").match(
    /const microphone_usage_text = "([^"]+)";/
  )?.[1];
  assert.ok(sentence, "build.zig has no microphone_usage_text.");
  assert.match(
    read("scripts/copy-agent-into-app.sh"),
    new RegExp(`mic_text="${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    "copy-agent-into-app.sh sets other microphone text than build.zig. The packaged prompt and the dev prompt must match."
  );
  const config = JSON.parse(read("app.json"));
  assert.ok(
    config.permissions.includes("microphone"),
    "app.json does not list the microphone permission, so macOS never offers the prompt."
  );
});

test("Sage loads the speech library at run time and never links it", () => {
  const build = stripComments(read("build.zig"), "zig");
  for (const line of build.split("\n")) {
    if (
      /\b(linkFramework|linkSystemLibrary|linkLibrary|addObjectFile|addLibraryPath|addFrameworkPath|addRPath)\(/.test(
        line
      )
    ) {
      assert.doesNotMatch(
        line,
        /speech|swift/i,
        `build.zig links ${line.trim()}. The Speech framework and the Swift runtime need macOS 26, and Sage runs on macOS 11 and later, so the speech engine must stay in libSageSpeech.dylib.`
      );
    }
  }

  const apple = stripComments(read("src/speech_apple.zig"), "zig");
  assert.match(
    apple,
    /std\.DynLib\.open\(/,
    "speech_apple.zig no longer loads the library with DynLib."
  );
  for (const file of filesUnder("src", [".zig"])) {
    const code = stripComments(read(file), "zig");
    assert.doesNotMatch(
      code,
      /\bextern\b[^\n]*(sage_speech|Speech\.framework)|"Speech"/,
      `${file} links the speech engine. An extern declaration makes the loader need it at launch, and Sage would not start on macOS before 26.`
    );
  }
});

// The same rule on a real binary. It needs a build, so it is skipped when
// there is none, as in the CI run that only checks and tests.
test("a built Sage links neither the Speech framework nor Swift", {
  skip:
    !existsSync(join(repoRoot, "zig-out/bin/Sage")) ||
    !existsSync("/usr/bin/otool"),
}, () => {
  const linked = execFileSync(
    "/usr/bin/otool",
    ["-L", join(repoRoot, "zig-out/bin/Sage")],
    { encoding: "utf8" }
  );
  assert.doesNotMatch(
    linked,
    /Speech\.framework|libSageSpeech|libswift|Swift\.framework/,
    `zig-out/bin/Sage links the speech engine:\n${linked}\nIt must load libSageSpeech.dylib at run time instead.`
  );
});

test("the rules catch what they are written for", () => {
  assert.ok(
    violations(
      stripComments(
        "let f = FileManager.default.createFile(atPath: p)",
        "swift"
      ),
      swiftFileWrites
    ).length > 0
  );
  assert.ok(
    violations(
      stripComments("try dir.createFile(io, name, .{});", "zig"),
      zigFileWrites
    ).length > 0
  );
  assert.ok(
    violations(stripComments('print("heard \\(text)")', "swift"), swiftLogging)
      .length > 0
  );
  assert.ok(
    violations(
      stripComments('std.log.info("heard {s}", .{text});', "zig"),
      zigLogging
    ).length > 0
  );
  assert.deepEqual(
    formatPlaceholders('std.debug.print("{d} events, {s}\\n", .{ n, text });'),
    ["{d}", "{s}"]
  );
  // A comment that says what the code does not do is not a violation.
  assert.deepEqual(
    violations(
      stripComments("// never print( or createFile( here\nlet x = 1", "swift"),
      [...swiftLogging, ...swiftFileWrites]
    ),
    []
  );
  assert.deepEqual(
    violations(
      stripComments(
        "/// Nothing here calls std.log or rename.\nconst x = 1;",
        "zig"
      ),
      [...zigLogging, ...zigFileWrites]
    ),
    []
  );
  // Reading a file and building a path are allowed.
  assert.deepEqual(
    violations(
      stripComments(
        "const wav = try std.Io.Dir.cwd().readFileAlloc(io, p, a, .limited(1));\nconst d = std.fs.path.dirname(p);",
        "zig"
      ),
      zigFileWrites
    ),
    []
  );
});
