#!/bin/sh
# 没有 pnpm 时的手动安装：把插件解到 DSH profile 的 node_modules，并登记为 bundle。
# 可重复执行（覆盖安装）；第一次会备份 profile 的 package.json。
#
# 用法：sh install-local.sh <插件 .tgz 或插件目录> [profile 目录]
#   profile 目录默认 ${DSH_HOME:-~/.dsh}/profiles/web；桌面版是 ~/.dsh/profiles/desktop。
# 装完重启 DSH。
set -e

SRC="$1"
P="${2:-${DSH_HOME:-$HOME/.dsh}/profiles/web}"
NAME=dsh-novel-continue

if [ -z "$SRC" ] || [ ! -e "$SRC" ]; then
  echo "用法：sh install-local.sh <插件 .tgz 或插件目录> [profile 目录]" >&2
  exit 1
fi
if [ ! -f "$P/package.json" ]; then
  echo "找不到 profile：$P（先用这个 profile 启动一次 DSH，让它完成初始化）" >&2
  exit 1
fi

SRC_ABS="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
DEST="$P/node_modules/$NAME"
rm -rf "$DEST"
mkdir -p "$DEST"
if [ -f "$SRC_ABS" ]; then
  tar xzf "$SRC_ABS" -C "$DEST" --strip-components=1
else
  (cd "$SRC_ABS" && tar cf - --exclude node_modules --exclude .git .) | (cd "$DEST" && tar xf -)
fi

[ -f "$P/package.json.bak-novel" ] || cp "$P/package.json" "$P/package.json.bak-novel"
node -e '
const fs = require("fs");
const [profile, name, spec] = process.argv.slice(1);
const file = profile + "/package.json";
const j = JSON.parse(fs.readFileSync(file, "utf8"));
j.dependencies = { ...(j.dependencies || {}), [name]: spec };
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
const bundles = j.dsh.profile.bundles = j.dsh.profile.bundles || [];
if (!bundles.includes(name)) bundles.push(name);
fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
' "$P" "$NAME" "file:$SRC_ABS"

echo "已安装 $NAME 到 $P，重启 DSH 生效。"
