#!/usr/bin/env python3
"""Apply a declarative Zen sidebar layout to a closed browser profile."""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import lz4.block


MOZLZ4_HEADER = b"mozLz40\0"


def read_session(path: Path) -> dict:
    raw = path.read_bytes()
    if not raw.startswith(MOZLZ4_HEADER):
        raise ValueError(f"{path} is not a Mozilla LZ4 session file")
    return json.loads(lz4.block.decompress(raw[len(MOZLZ4_HEADER) :]))


def write_session(path: Path, data: dict) -> None:
    serialized = json.dumps(
        data, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    compressed = lz4.block.compress(serialized, store_size=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(MOZLZ4_HEADER + compressed)
    read_session(temporary)
    temporary.replace(path)


def canonical_url(url: str) -> str:
    parts = urlsplit(url.strip())
    path = parts.path.rstrip("/") or "/"
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), path, parts.query, parts.fragment)
    )


def tab_entry(tab: dict) -> dict:
    entries = tab.get("entries") or [{}]
    return entries[-1]


def find_space(spaces: list[dict], aliases: list[str]) -> dict:
    wanted = {alias.casefold() for alias in aliases}
    matches = [space for space in spaces if space.get("name", "").casefold() in wanted]
    if len(matches) != 1:
        raise ValueError(f"Expected one Space matching {aliases}, found {len(matches)}")
    return matches[0]


def create_tab(item: dict, space: dict, group_id: str | None) -> dict:
    now = int(time.time() * 1000)
    sync_id = f"layout-{now}-{abs(hash((item['url'], item['title']))) % 1000000}"
    return {
        "entries": [{"url": item["url"], "title": item["title"]}],
        "lastAccessed": now,
        "pinned": True,
        "hidden": False,
        "groupId": group_id,
        "zenWorkspace": space["uuid"],
        "zenSyncId": sync_id,
        "zenEssential": bool(item.get("essential")),
        "zenDefaultUserContextId": "true",
        "zenPinnedIcon": None,
        "zenIsEmpty": False,
        "zenHasStaticIcon": False,
        "zenGlanceId": None,
        "zenIsGlance": False,
        "_zenPinnedInitialState": {
            "entry": {"url": item["url"], "title": item["title"]}
        },
        "zenLiveFolderItemId": None,
        "searchMode": None,
        "userContextId": space.get("containerTabId", 0),
        "attributes": {},
        "index": 1,
        "userTypedValue": "",
        "userTypedClear": 0,
    }


def folder_records(
    existing_folders: list[dict],
    existing_groups: list[dict],
    space: dict,
    folder_specs: list[dict],
) -> tuple[list[dict], list[dict], dict[str, str]]:
    wanted_names = {folder["name"] for folder in folder_specs}
    kept_folders = [
        folder
        for folder in existing_folders
        if folder.get("workspaceId") != space["uuid"]
        or folder.get("name") in wanted_names
    ]
    kept_ids = {folder["id"] for folder in kept_folders}
    kept_groups = [
        group
        for group in existing_groups
        if group.get("id") in kept_ids
        or not any(
            folder.get("id") == group.get("id")
            and folder.get("workspaceId") == space["uuid"]
            for folder in existing_folders
        )
    ]

    ids: dict[str, str] = {}
    for position, spec in enumerate(folder_specs):
        current = next(
            (
                folder
                for folder in kept_folders
                if folder.get("workspaceId") == space["uuid"]
                and folder.get("name") == spec["name"]
            ),
            None,
        )
        folder_id = (
            current["id"]
            if current
            else f"layout-{space['uuid'].strip('{}')[:8]}-{position + 1}"
        )
        ids[spec["name"]] = folder_id
        if current is None:
            current = {
                "pinned": True,
                "splitViewGroup": False,
                "id": folder_id,
                "name": spec["name"],
                "collapsed": bool(spec.get("collapsed", False)),
                "saveOnWindowClose": True,
                "parentId": None,
                "prevSiblingInfo": None,
                "emptyTabIds": [],
                "userIcon": spec.get("icon", ""),
                "workspaceId": space["uuid"],
            }
            kept_folders.append(current)
        else:
            current["collapsed"] = bool(spec.get("collapsed", False))
            current["userIcon"] = spec.get("icon", current.get("userIcon", ""))

        group = next(
            (group for group in kept_groups if group.get("id") == folder_id), None
        )
        if group is None:
            kept_groups.append(
                {
                    "pinned": True,
                    "splitView": False,
                    "id": folder_id,
                    "name": spec["name"],
                    "color": "zen-workspace-color",
                    "collapsed": bool(spec.get("collapsed", False)),
                    "saveOnWindowClose": True,
                }
            )
        else:
            group["name"] = spec["name"]
            group["collapsed"] = bool(spec.get("collapsed", False))

    return kept_folders, kept_groups, ids


def apply_layout(session: dict, manifest: dict) -> tuple[dict, list[str]]:
    result = copy.deepcopy(session)
    changes: list[str] = []
    current_space_ids = {space["uuid"] for space in result["spaces"]}

    for spec in manifest["spaces"]:
        space = find_space(result["spaces"], spec["aliases"])
        old_name = space["name"]
        if old_name != spec["name"]:
            space["name"] = spec["name"]
            changes.append(f"Rename Space: {old_name} -> {spec['name']}")

        if spec.get("preserve"):
            changes.append(f"Preserve Space contents: {spec['name']}")
            continue

        folder_specs = spec.get("folders", [])
        old_folder_ids = {
            folder["id"]
            for folder in result["folders"]
            if folder.get("workspaceId") == space["uuid"]
        }
        result["folders"], result["groups"], folder_ids = folder_records(
            result["folders"], result.get("groups", []), space, folder_specs
        )
        removed_folders = old_folder_ids - set(folder_ids.values())
        if removed_folders:
            changes.append(
                f"Remove {len(removed_folders)} obsolete folder record(s) from {spec['name']}"
            )

        desired_items = []
        for item in spec.get("essentials", []):
            desired_items.append({**item, "essential": True, "folder": None})
        for item in spec.get("pins", []):
            desired_items.append({**item, "essential": False})

        selected: list[dict] = []
        selected_ids: set[int] = set()
        all_wanted_urls = {
            canonical_url(candidate)
            for item in desired_items
            for candidate in [item["url"], *item.get("matchUrls", [])]
        }

        for item in desired_items:
            candidates = {
                canonical_url(item["url"]),
                *(canonical_url(url) for url in item.get("matchUrls", [])),
            }
            matching_tabs = [
                candidate
                for candidate in result["tabs"]
                if canonical_url(tab_entry(candidate).get("url", "")) in candidates
                and id(candidate) not in selected_ids
            ]
            tab = next(
                (
                    candidate
                    for candidate in matching_tabs
                    if candidate.get("zenWorkspace") == space["uuid"]
                ),
                None,
            )
            if tab is None:
                tab = next(
                    (
                        candidate
                        for candidate in matching_tabs
                        if candidate.get("zenWorkspace") not in current_space_ids
                    ),
                    None,
                )
            group_id = folder_ids.get(item.get("folder"))
            if tab is None:
                tab = create_tab(item, space, group_id)
                result["tabs"].append(tab)
                changes.append(f"Add {spec['name']}: {item['title']}")
            else:
                changes.append(f"Reuse {spec['name']}: {item['title']}")
            selected_ids.add(id(tab))
            tab["entries"] = [{"url": item["url"], "title": item["title"]}]
            tab["pinned"] = True
            tab["hidden"] = False
            tab["groupId"] = group_id
            tab["zenWorkspace"] = space["uuid"]
            tab["zenEssential"] = bool(item.get("essential"))
            tab["zenIsEmpty"] = False
            tab["userContextId"] = space.get("containerTabId", 0)
            tab["_zenPinnedInitialState"] = {
                "entry": {"url": item["url"], "title": item["title"]}
            }
            selected.append(tab)

        unmanaged = []
        for tab in result["tabs"]:
            if id(tab) in selected_ids:
                continue
            url = canonical_url(tab_entry(tab).get("url", ""))
            belongs_to_space = tab.get("zenWorkspace") == space["uuid"]
            belongs_to_removed_folder = tab.get("groupId") in removed_folders
            duplicate_wanted_url = url in all_wanted_urls
            is_legacy_duplicate = (
                duplicate_wanted_url
                and tab.get("zenWorkspace") not in current_space_ids
            )
            if tab.get("pinned") and (
                belongs_to_space or belongs_to_removed_folder or is_legacy_duplicate
            ):
                tab["pinned"] = False
                tab["zenEssential"] = False
                tab["groupId"] = None
                changes.append(
                    f"Unpin extra from {spec['name']}: "
                    f"{tab_entry(tab).get('title') or url or 'blank tab'}"
                )
            unmanaged.append(tab)

        result["tabs"] = selected + unmanaged

    return result, changes


def validate(session: dict, manifest: dict) -> None:
    folder_ids = {folder["id"] for folder in session["folders"]}
    group_ids = {group["id"] for group in session.get("groups", [])}
    if folder_ids != group_ids:
        raise ValueError("Folder and group IDs differ after layout generation")
    for tab in session["tabs"]:
        if tab.get("groupId") and tab["groupId"] not in folder_ids:
            raise ValueError(f"Tab references unknown folder {tab['groupId']}")
    for spec in manifest["spaces"]:
        space = find_space(session["spaces"], [spec["name"]])
        if spec.get("preserve"):
            continue
        pinned = [
            tab
            for tab in session["tabs"]
            if tab.get("zenWorkspace") == space["uuid"] and tab.get("pinned")
        ]
        expected = len(spec.get("essentials", [])) + len(spec.get("pins", []))
        if len(pinned) != expected:
            raise ValueError(
                f"{spec['name']} has {len(pinned)} managed pins, expected {expected}"
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    original = read_session(args.session)
    updated, changes = apply_layout(original, manifest)
    validate(updated, manifest)

    for change in changes:
        print(change)
    print(f"Validated {len(updated['spaces'])} Spaces, {len(updated['tabs'])} tabs")

    if args.apply:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = args.session.with_name(f"{args.session.name}.before-layout-{stamp}")
        shutil.copy2(args.session, backup)
        write_session(args.session, updated)
        print(f"Applied layout; automatic backup: {backup}")
    else:
        print("Dry run only; use --apply to write the validated layout")
    return 0


if __name__ == "__main__":
    sys.exit(main())
