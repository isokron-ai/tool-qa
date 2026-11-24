#!/usr/bin/env bash
# Install the age binaries (age, age-keygen) from the official release, pinned
# by exact version and sha256. Linux only (GitHub-hosted runners).
#
#   bash worker-kit/install-age.sh <dest-dir>
#
# The checksums were taken from the release's published asset digests and
# confirmed by downloading the files and hashing them.
set -euo pipefail

AGE_VERSION="v1.3.2"
AGE_SHA256_LINUX_AMD64="cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10"
AGE_SHA256_LINUX_ARM64="6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4"

dest="${1:?usage: install-age.sh <dest-dir>}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-age.sh: only Linux runners are supported" >&2
  exit 1
fi

case "${RUNNER_ARCH:-$(uname -m)}" in
  X64 | x86_64 | amd64) arch="amd64"; sha="$AGE_SHA256_LINUX_AMD64" ;;
  ARM64 | aarch64 | arm64) arch="arm64"; sha="$AGE_SHA256_LINUX_ARM64" ;;
  *) echo "install-age.sh: unsupported architecture" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
archive="$tmp/age.tar.gz"
url="https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${arch}.tar.gz"

curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$archive" "$url"
echo "${sha}  ${archive}" | sha256sum --check --strict --quiet -

mkdir -p "$dest"
tar -xzf "$archive" -C "$tmp" age/age age/age-keygen
install -m 0755 "$tmp/age/age" "$dest/age"
install -m 0755 "$tmp/age/age-keygen" "$dest/age-keygen"
"$dest/age" --version
