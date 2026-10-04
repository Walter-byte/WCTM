#!/bin/sh
set -eu

# Keep the Alpine 3.24 runtime packages reproducible even if its repository moves.
openssl_version=3.5.9-r0
apk_arch="$(apk --print-arch)"

case "$apk_arch" in
  x86_64)
    crypto_sha256=6632d758d8f5e9ea3b650fe966f23bbf9a202f8b8dceecac93da135dec5e3689
    ssl_sha256=05e3393fb95aa5751ca2f9d242f659f6cff82c1cc7767cc2df4a086f7ad01877
    ;;
  aarch64)
    crypto_sha256=2676a2b0b6e23ea2edccf3ee982b9842a665d52603d047de3d0a185dc316d983
    ssl_sha256=20ac252b276d73f2c69c1d25f84537c7fba81caefc026c6be1094b394af2082e
    ;;
  s390x)
    crypto_sha256=dd1306432008b30a85d0608a51e11a4e720820cd938eebd7bf8537546c62dcc0
    ssl_sha256=5d192c2188aef76a4947d580aa522cde980c08d5491ad40965dbc2f7b41ff6f5
    ;;
  *)
    echo "Unsupported Alpine architecture: $apk_arch" >&2
    exit 1
    ;;
esac

apk_dir="$(mktemp -d)"
trap 'rm -rf "$apk_dir"' EXIT HUP INT TERM
apk_base="https://dl-cdn.alpinelinux.org/alpine/v3.24/main/$apk_arch"

fetch_verified() {
  apk_file="$apk_dir/$1-$openssl_version.apk"
  wget -q -O "$apk_file" "$apk_base/$1-$openssl_version.apk"
  printf '%s  %s\n' "$2" "$apk_file" | sha256sum -c -
  apk verify "$apk_file"
}

fetch_verified libcrypto3 "$crypto_sha256"
fetch_verified libssl3 "$ssl_sha256"

apk add --repositories-file /dev/null --no-network --no-cache --upgrade \
  "$apk_dir/libcrypto3-$openssl_version.apk" \
  "$apk_dir/libssl3-$openssl_version.apk"
