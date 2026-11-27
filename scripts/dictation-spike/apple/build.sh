#!/bin/sh
# Builds the Apple SpeechAnalyzer runner into ../.build/transcribe-apple.
# Needs macOS 26 or later and the Xcode or Command Line Tools SDK for it.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../.build"
mkdir -p "$out"

xcrun swiftc -O -swift-version 5 -parse-as-library \
  -target arm64-apple-macos26.0 \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist" \
  "$here/Transcribe.swift" -o "$out/transcribe-apple"

echo "$out/transcribe-apple"
