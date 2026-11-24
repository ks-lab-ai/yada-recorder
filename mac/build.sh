#!/bin/bash
# Construit "Yada Recorder.app" (app Mac native, un gros bouton) dans mac/build/.
# Config Supabase : variables SUPABASE_URL et SUPABASE_KEY, ou fichier mac/config.env (non versionné).
# Sans config, l'app demande l'URL et la clé au premier lancement (gardées dans le Trousseau).
set -euo pipefail
cd "$(dirname "$0")"
[ -f config.env ] && source config.env

APP="build/Yada Recorder.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -swift-version 5 -parse-as-library \
  -target "$(uname -m)-apple-macos15.0" \
  YadaRecorder.swift -o "$APP/Contents/MacOS/Yada Recorder"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.yadarecorder.app</string>
  <key>CFBundleName</key><string>Yada Recorder</string>
  <key>CFBundleDisplayName</key><string>Yada Recorder</string>
  <key>CFBundleExecutable</key><string>Yada Recorder</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.1</string>
  <key>CFBundleVersion</key><string>3</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Yada Recorder enregistre ta voix pendant tes appels.</string>
  <key>NSAudioCaptureUsageDescription</key><string>Yada Recorder enregistre le son de tes appels.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Yada Recorder transcrit tes appels sur ton Mac, sans rien envoyer en ligne.</string>
</dict></plist>
EOF

cat > "$APP/Contents/Resources/Config.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>SupabaseURL</key><string>${SUPABASE_URL:-}</string>
  <key>SupabaseKey</key><string>${SUPABASE_KEY:-}</string>
  <key>Bucket</key><string>call-recordings</string>
</dict></plist>
EOF

# Icône : mac/AppIcon.png (fond vert, combiné, point rouge)
ICON=AppIcon.png
SET=build/AppIcon.iconset
rm -rf "$SET" && mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d "$ICON" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$SET"

codesign --force --sign - "$APP"
echo "OK : mac/$APP"
