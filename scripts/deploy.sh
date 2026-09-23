#!/usr/bin/env bash
# Публикация онлайн-версии на Vercel: https://umny-zakup.vercel.app
# Отправляется только папка web/ (без исходных Excel и кода расчёта).
# Публикуем из временной папки вне git, чтобы Vercel не блокировал выкладку
# из-за несовпадения автора коммита с владельцем аккаунта.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$ROOT/web/." "$TMP/"
mkdir -p "$TMP/.vercel"
cp "$ROOT/.vercel/project.json" "$TMP/.vercel/"
python3 - "$ROOT/vercel.json" "$TMP/vercel.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1])); v["outputDirectory"] = "."
json.dump(v, open(sys.argv[2], "w"), ensure_ascii=False, indent=2)
PY
(cd "$TMP" && npx --yes vercel@latest deploy --prod --yes)
node "$ROOT/scripts/check_site.js"
