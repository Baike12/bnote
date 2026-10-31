#!/usr/bin/env bash
# 创建 bnote 的本地代码签名身份(自签证书)。只需跑一次;重复跑是幂等的。
#
# 为什么必须签名:macOS 的辅助功能(TCC)授权是按应用的 **designated
# requirement** 记录的。未签名 / adhoc 链接器签名的应用,DR 就是
#   designated => cdhash H"..."
# 二进制一变(每次构建)cdhash 就变,TCC 里那条旧授权再也匹配不上——表现就是
# 「系统设置里 bnote 明明开着,应用还说没权限;点了又弹一次授权」,永远循环。
# 换成自签证书后 DR 变成
#   designated => identifier "com.bnote.app" and certificate root = H"<证书 SHA1>"
# 身份只跟证书绑定,重建多少次都认同一份授权。
set -euo pipefail

SIGN_KC="$HOME/Library/Keychains/bnote-dev.keychain-db"
SIGN_ID="bnote-dev"
SIGN_PASS="${BNOTE_SIGN_PASSWORD:-bnote-dev-sign}"

echo "==> 钥匙串: $SIGN_KC"
mkdir -p "$(dirname "$SIGN_KC")"
if [ ! -f "$SIGN_KC" ]; then
  security create-keychain -p "$SIGN_PASS" "$SIGN_KC"
  echo "    已创建"
else
  echo "    已存在"
fi
security set-keychain-settings -lut 21600 "$SIGN_KC"
security unlock-keychain -p "$SIGN_PASS" "$SIGN_KC"

if security find-identity -p codesigning "$SIGN_KC" | grep -q "\"$SIGN_ID\""; then
  echo "==> 身份已存在: $SIGN_ID"
else
  echo "==> 生成自签证书: $SIGN_ID"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  # 必须带 codeSigning 的 EKU,codesign 只认这种证书。
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
    -subj "/CN=$SIGN_ID/O=bnote Dev/C=CN" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1
  # -legacy:macOS 的 security 读不了 openssl 3+ 默认的 PBES2 加密 p12。
  if ! openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
      -out "$TMP/id.p12" -passout pass:"$SIGN_PASS" -name "$SIGN_ID" 2>/dev/null; then
    openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
      -out "$TMP/id.p12" -passout pass:"$SIGN_PASS" -name "$SIGN_ID" >/dev/null
  fi
  security import "$TMP/id.p12" -k "$SIGN_KC" -P "$SIGN_PASS" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  # 让 codesign 用私钥时不再弹钥匙串授权框。
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$SIGN_PASS" "$SIGN_KC" >/dev/null
  echo "    完成"
fi

# codesign 只在**钥匙串搜索列表**里找身份:单独 --keychain 会报 "no identity found"。
LIST="$(security list-keychains -d user | sed 's/^[[:space:]]*//;s/"//g')"
if ! printf '%s\n' "$LIST" | grep -qx "$SIGN_KC"; then
  # shellcheck disable=SC2086 — 原列表按行拆成多个参数
  security list-keychains -d user -s "$SIGN_KC" $LIST
  echo "==> 已加入钥匙串搜索列表"
fi

echo
echo "✓ 签名身份就绪:"
security find-identity -p codesigning "$SIGN_KC" | grep "$SIGN_ID" | sed 's/^/    /'
echo
echo "下一步: deploy.sh 会自动用它签名;签名后 DR 是"
echo "    identifier \"com.bnote.app\" and certificate root = H\"…\""
echo "辅助功能授权从此跨重建有效。"
