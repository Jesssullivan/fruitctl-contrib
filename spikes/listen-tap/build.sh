#!/bin/bash
# Build the spike CLI and an ad-hoc signed app bundle in this directory.
# Darwin arm64 only. No install, no system change. TIN-5509.
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O -o listen-tap ListenTap.swift
rm -rf ListenTapStream3.app
mkdir -p ListenTapStream3.app/Contents/MacOS
cp Info.plist ListenTapStream3.app/Contents/Info.plist
cp listen-tap ListenTapStream3.app/Contents/MacOS/listen-tap
codesign --force --sign - --timestamp=none ListenTapStream3.app
codesign --display --verbose=2 ListenTapStream3.app 2>&1 | grep -E 'Identifier|CDHash|Signature'
