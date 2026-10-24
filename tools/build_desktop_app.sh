#!/bin/zsh
# (Re)construit l'icone bureau OSCR.app, qui ouvre la fenetre de controle (tools/oscr_panel.py).
# Usage : zsh tools/build_desktop_app.sh  [dossier-cible]   (defaut: ~/Desktop)
set -u
HERE=${0:A:h}
SRC="$HOME/OSCR/website/public/brand/logo-original.png"
DEST="${1:-$HOME/Desktop}"
APP="$DEST/OSCR.app"

# Icone .icns depuis le logo
rm -rf "$HERE/OSCR.iconset"; mkdir "$HERE/OSCR.iconset"
for s in 16 32 64 128 256 512; do
  sips -z $s $s "$SRC" --out "$HERE/OSCR.iconset/icon_${s}x${s}.png" >/dev/null 2>&1
  d=$((s*2)); sips -z $d $d "$SRC" --out "$HERE/OSCR.iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1
done
iconutil -c icns "$HERE/OSCR.iconset" -o "$HERE/OSCR.icns" && rm -rf "$HERE/OSCR.iconset"
sips -Z 96 "$SRC" --out "$HERE/oscr-logo-96.png" >/dev/null 2>&1
sips -Z 36 "$SRC" --out "$HERE/oscr-icon.png" >/dev/null 2>&1

rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/OSCR.icns" "$APP/Contents/Resources/OSCR.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>OSCR</string>
  <key>CFBundleDisplayName</key><string>OSCR</string>
  <key>CFBundleExecutable</key><string>OSCR</string>
  <key>CFBundleIconFile</key><string>OSCR</string>
  <key>CFBundleIdentifier</key><string>org.oscr.panel</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/OSCR" <<'LAUNCH'
#!/bin/zsh
exec /Users/neuracrypt/OSCR/.venv/bin/python /Users/neuracrypt/OSCR/tools/oscr_panel.py
LAUNCH
chmod +x "$APP/Contents/MacOS/OSCR"
echo "OSCR.app cree dans $DEST"
