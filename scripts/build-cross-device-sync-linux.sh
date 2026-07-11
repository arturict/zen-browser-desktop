#!/usr/bin/env bash

set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
export ZEN_SYNC_BRANCH="${ZEN_SYNC_BRANCH:-codex/cross-device-sidebar-sync}"
export ZEN_SYNC_JOBS="${ZEN_SYNC_JOBS:-4}"
export ZEN_SYNC_REPOSITORY="${ZEN_SYNC_REPOSITORY:-https://github.com/arturict/zen-browser-desktop.git}"
export ZEN_DISABLE_LTO="${ZEN_DISABLE_LTO:-1}"

apt-get update
apt-get install -y \
  autoconf \
  automake \
  bison \
  build-essential \
  bzip2 \
  ca-certificates \
  cabextract \
  clang \
  curl \
  dos2unix \
  git \
  libasound2-dev \
  libcurl4-openssl-dev \
  libdbus-1-dev \
  libdbus-glib-1-dev \
  libdrm-dev \
  libgtk-3-dev \
  libgtk2.0-dev \
  libpulse-dev \
  libpython3-dev \
  libx11-xcb-dev \
  libxt-dev \
  lld \
  llvm \
  locales \
  m4 \
  nasm \
  ninja-build \
  python3 \
  python3-pip \
  python3-venv \
  sudo \
  unzip \
  uuid-dev \
  wget \
  xz-utils \
  xvfb \
  yasm \
  zip \
  zstd

if ! id builder >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash builder
fi
echo "builder ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/builder
mkdir -p /work /artifacts
chown builder:builder /work /artifacts

sudo -H -u builder env \
  ZEN_SYNC_BRANCH="${ZEN_SYNC_BRANCH}" \
  ZEN_SYNC_JOBS="${ZEN_SYNC_JOBS}" \
  ZEN_SYNC_REPOSITORY="${ZEN_SYNC_REPOSITORY}" \
  ZEN_DISABLE_LTO="${ZEN_DISABLE_LTO}" \
  bash <<'BUILD'
set -euxo pipefail

cd /work
if ! test -d source/.git; then
  git clone --depth 1 --branch "${ZEN_SYNC_BRANCH}" "${ZEN_SYNC_REPOSITORY}" source
fi
cd source

if ! test -f "${HOME}/.cargo/env"; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --default-toolchain 1.90
fi
source "${HOME}/.cargo/env"

if ! test -d engine; then
  npm ci
  npm run surfer -- ci --brand release --display-version 1.21.6b
  npm run download
fi

git -C engine config user.name "Zen Sync Builder"
git -C engine config user.email "zen-sync-builder@localhost"
if ! git -C engine rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C engine add -A
  git -C engine commit -m "Firefox build baseline"
fi

if ! test -f engine/zen/sync/ZenSyncManager.sys.mjs; then
  npm run import
fi

cd engine
./mach --no-interactive bootstrap --application-choice browser
cd ..

npm run build -- -j "${ZEN_SYNC_JOBS}"
SURFER_PLATFORM=linux ZEN_RELEASE=1 npm run package

cp dist/zen-*.tar.xz /artifacts/
if test -f dist/output.mar; then
  cp dist/output.mar /artifacts/
fi
git rev-parse HEAD >/artifacts/source-commit.txt
BUILD
