# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from pathlib import Path
import shutil

from copy_language_pack import get_language_code


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = REPOSITORY_ROOT / "locales"
DESTINATION_ROOT = REPOSITORY_ROOT / "engine" / "browser" / "locales"


def copy_zen_locale_overlays() -> int:
  copied = 0
  for locale_dir in sorted(path for path in SOURCE_ROOT.iterdir() if path.is_dir()):
    source_browser = locale_dir / "browser"
    if not source_browser.is_dir():
      continue

    destination_locale = DESTINATION_ROOT / get_language_code(locale_dir.name)
    for source in sorted(source_browser.rglob("*.ftl")):
      destination = destination_locale / source.relative_to(source_browser)
      destination.parent.mkdir(parents=True, exist_ok=True)
      shutil.copy2(source, destination)
      copied += 1

  return copied


if __name__ == "__main__":
  count = copy_zen_locale_overlays()
  if not count:
    raise SystemExit("No Zen locale overlays were found")
  print(f"Copied {count} Zen locale overlays")
