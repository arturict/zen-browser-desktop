# Cross-device sidebar sync

This fork extends Zen's Firefox Sync engine with durable sidebar state. It uses
the Mozilla account already configured in Zen, so it does not require Convex,
a companion service, or a second login.

## Synchronized data

- Spaces, their order, themes, and assigned containers
- Public container names, icons, and colors
- Pinned tabs and Essentials, including their original pinned URL
- Static tab labels and icons
- Folders, nesting, collapsed state, and sidebar ordering
- Split views made entirely from pinned tabs

Ordinary tabs, current navigation, page history, form data, scroll position,
cookies, logins, Firefox browser profiles, local files, and executable browser
URLs are intentionally excluded. Synced pins accept HTTP(S) and safe `about:`
pages. A remote update never navigates a pinned tab that is already open
locally. Its active container is also left unchanged; a new synced pin is
created directly in the mapped local container instead.

## Safety model

Before applying remote data, Zen copies `zen-sessions.jsonlz4`,
`containers.json`, and `prefs.js` into a timestamped directory under
`<profile>/zen-sync-backups/`. A failed backup aborts the incoming apply. The
20 newest recovery snapshots are retained.

The Sync engine stores one encrypted record per Space, container, pinned tab,
folder, or split view. This avoids whole-profile last-write-wins replacement.
Firefox Sync remains near-real-time rather than guaranteed instant delivery.
Containers use opaque Sync IDs with a profile-local mapping; device-local
numeric container IDs are never used as cross-device identity. Matching
pre-existing Spaces, folders, pins, split views, and same-name container
ordinals are reconciled deterministically. Position is part of Space, folder,
and pin reconciliation, so ambiguous local items are preserved instead of
silently collapsed.

Container records synchronize the identity used by Spaces and pins, not the
container's cookies or site data. A remote container tombstone never calls
Firefox's destructive container-removal API; removing a container and its site
data remains an explicit, device-local action.

Tracked changes are persisted under the profile's Firefox Sync data directory,
so edits made while offline survive a browser restart and upload later.

## Setup

1. Install the same fork build on each Windows or Linux device.
2. Sign in to the same Mozilla account in `Settings > Sync` on each device.
3. Keep `Sync` enabled and use `Sync Now` once after the first device uploads.
4. Open the next device and use `Sync Now` again.

The first merge is non-destructive. If two pre-existing layouts are genuinely
different, both items can remain rather than one device being treated as an
implicit authority.

## Reproducible builds

The scripts in `scripts/build-cross-device-sync-linux.sh` and
`scripts/build-cross-device-sync-windows.sh` clone the public branch into an
isolated Docker container, build with bounded parallelism, and place packages
under `/artifacts`. They default to four build jobs, disable LTO, and omit the
unrelated crash reporter so the Firefox link fits in a 16 GiB Docker VM. They
do not mount a Zen profile. The Windows preview also disables PGO and omits
debug symbols to keep its cross-compiled final link within that memory ceiling.
Its Windows App SDK dependency is fetched directly from Mozilla's public
Taskcluster toolchain artifacts.

From PowerShell in the repository root, a Linux x64 preview build can be run
with:

```powershell
docker run --name zen-sync-linux-build `
  --mount "type=bind,source=$PWD\scripts\build-cross-device-sync-linux.sh,target=/build.sh,readonly" `
  node:22-bookworm bash /build.sh
docker cp zen-sync-linux-build:/artifacts/. .\dist\cross-device-sync\linux
```

The Windows x64 cross-build uses Zen's Linux-to-Windows toolchain flow:

```powershell
docker run --name zen-sync-windows-build `
  --mount "type=bind,source=$PWD\scripts\build-cross-device-sync-windows.sh,target=/build.sh,readonly" `
  ubuntu:24.04 bash /build.sh
docker cp zen-sync-windows-build:/artifacts/. .\dist\cross-device-sync\windows
```

These are unsigned preview builds. Test them with a disposable browser profile
before pointing them at an existing profile.

Use a separate Mozilla account when two Firefox browser profiles should stay
isolated. Zen Spaces are synchronized; entire Firefox profile directories are
not.
