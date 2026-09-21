#!/bin/sh
# Runs the Electron tests against the code inside the BUILT app (its app.asar), not the source tree.
# This is the check that catches a file missing from the package (build.files) while `npm start`
# still works. Build first: npm run build
set -e
cd "$(dirname "$0")/.."
ASAR="$PWD/dist/mac-arm64/Blob.app/Contents/Resources/app.asar"
if [ ! -f "$ASAR" ]; then
  echo "No built app at $ASAR: run 'npm run build' first." >&2
  exit 1
fi
export BLOB_MAIN="$ASAR/main.js"
echo "Testing the packaged sources: $BLOB_MAIN"
npm run test:app
npm run test:ui
npm run test:notes
