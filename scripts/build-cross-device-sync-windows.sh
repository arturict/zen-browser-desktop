#!/usr/bin/env bash

set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
export ZEN_SYNC_BRANCH="${ZEN_SYNC_BRANCH:-codex/cross-device-sidebar-sync}"
export ZEN_SYNC_JOBS="${ZEN_SYNC_JOBS:-4}"
export ZEN_SYNC_REPOSITORY="${ZEN_SYNC_REPOSITORY:-https://github.com/arturict/zen-browser-desktop.git}"
export ZEN_DISABLE_LTO="${ZEN_DISABLE_LTO:-1}"

apt-get update
apt-get install -y ca-certificates curl git software-properties-common sudo
add-apt-repository -y universe
add-apt-repository -y ppa:savoury1/backports
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -

apt-get update
apt-get install -y \
  aria2 \
  autoconf \
  autoconf2.13 \
  automake \
  bison \
  build-essential \
  bzip2 \
  cabextract \
  clang \
  cmake \
  dos2unix \
  flex \
  g++-multilib \
  gawk \
  gcc-multilib \
  gnupg \
  jq \
  libbz2-dev \
  libcurl4-openssl-dev \
  libdbus-1-dev \
  libdbus-glib-1-dev \
  libdrm-dev \
  libexpat1-dev \
  libffi-dev \
  libgtk-3-dev \
  libgtk2.0-dev \
  libncurses-dev \
  libpulse-dev \
  libpython3-dev \
  libsqlite3-dev \
  libssl-dev \
  libtool \
  libucl-dev \
  libx11-xcb-dev \
  libxml2-dev \
  libxt-dev \
  lld \
  llvm \
  m4 \
  msitools \
  nasm \
  ninja-build \
  nodejs \
  openssh-client \
  p7zip-full \
  pkg-config \
  procps \
  python3 \
  python3-launchpadlib \
  python3-pip \
  python3-requests \
  python3-toml \
  python3-venv \
  scons \
  subversion \
  tar \
  unzip \
  uuid \
  uuid-dev \
  wget \
  xz-utils \
  yasm \
  zip \
  zlib1g-dev \
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
rustup target add x86_64-pc-windows-msvc

if ! test -d node_modules; then
  npm ci
fi
npm run surfer -- ci --brand release --display-version 1.21.6b
if ! test -d engine; then
  npm run download
fi

git -C engine config user.name "Zen Sync Builder"
git -C engine config user.email "zen-sync-builder@localhost"
if ! git -C engine rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C engine add -A
  git -C engine commit -m "Firefox build baseline"
fi

mkdir -p "${HOME}/win-cross"
if ! test -d "${HOME}/win-cross/vs2026/VC/Tools/MSVC"; then
  cd engine
  if ! test -d "${HOME}/win-cross/wine"; then
    aria2c \
      'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/dQz_aHy8Rl-Lt0xf2WlrMw/artifacts/public/build/wine.tar.zst' \
      -o wine.tar.zst
    tar --zstd -xf wine.tar.zst -C "${HOME}/win-cross"
    rm wine.tar.zst
  fi
  ./mach python --virtualenv build \
    taskcluster/scripts/misc/get_vs.py \
    build/vs/vs2026.yaml \
    "${HOME}/win-cross/vs2026"
  cd ..
fi

if ! test -f engine/zen/sync/ZenSyncManager.sys.mjs; then
  SURFER_COMPAT=x86_64 npm run import -- --verbose
fi
chmod -R +x "${HOME}/win-cross/vs2026" || true
SURFER_PLATFORM=win32 npm run bootstrap

clang_windows_lib="$(find "${HOME}/.mozbuild/clang/lib/clang" \
  -path '*/lib/windows' -type d -print -quit)"
if ! grep -q '^export LIB=' configs/common/mozconfig; then
  printf '\nexport LIB="%s"\n' "${clang_windows_lib}" >>configs/common/mozconfig
fi

windows_rs_version="$(cat build/windows/.windows-rs-version)"
cd engine
if ! command -v cargo-download >/dev/null 2>&1; then
  cargo install cargo-download --locked
fi
if ! test -d "windows-${windows_rs_version}"; then
  cargo download -x "windows=${windows_rs_version}"
fi
if ! grep -q '^export MOZ_WINDOWS_RS_DIR=' ../configs/common/mozconfig; then
  printf '\nexport MOZ_WINDOWS_RS_DIR=%s/windows-%s\n' \
    "$(pwd)" \
    "${windows_rs_version}" >>../configs/common/mozconfig
fi
cd ..

dos2unix configs/windows/mozconfig
SURFER_COMPAT=x86_64 \
  SURFER_PLATFORM=win32 \
  ZEN_CROSS_COMPILING=1 \
  npm run build -- -j "${ZEN_SYNC_JOBS}"

SURFER_COMPAT=x86_64 \
  SURFER_PLATFORM=win32 \
  ZEN_CROSS_COMPILING=1 \
  ZEN_RELEASE=1 \
  npm run package

cp dist/*.zip /artifacts/
if test -f dist/zen.installer.exe; then
  cp dist/zen.installer.exe /artifacts/
fi
if test -f dist/output.mar; then
  cp dist/output.mar /artifacts/
fi
git rev-parse HEAD >/artifacts/source-commit.txt
BUILD
