#!/usr/bin/env bash
# Builds OpenAI's official Sign in with ChatGPT DevKit (@siwc/local) into app/vendor/.
# The DevKit is not published to npm. It is licensed for noncommercial use (personal
# learning qualifies); see vendor/siwc-devkit/LICENSE. Only @siwc/local is built.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="https://github.com/openai/sign-in-with-chatgpt-devkit.git"
# Pinned for reproducibility; bump deliberately after reading the DevKit changelog.
COMMIT="${SIWC_COMMIT:-0a36fefeb913055c8c7a1a29b63d82b96b2e841a}"
DIR="vendor/siwc-devkit"

if [ ! -d "$DIR/.git" ]; then
  mkdir -p vendor
  git clone --quiet "$REPO" "$DIR"
fi
git -C "$DIR" fetch --quiet origin
git -C "$DIR" checkout --quiet "$COMMIT"
# Install only what @siwc/local needs; skip install scripts (no Electron download).
(cd "$DIR" && npm ci --workspace=@siwc/local --include-workspace-root --ignore-scripts --no-audit --no-fund)
(cd "$DIR" && npm run build --workspace=@siwc/local)
test -f "$DIR/packages/local/dist/index.js"
echo "Sign in with ChatGPT DevKit ready ($COMMIT)."
echo "Start Learn (npm start), open Settings, and choose “Sign in with ChatGPT”."
