/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SNAPSHOT_DIR_PATH = PathUtils.join(PathUtils.profileDir, "zen-sync");
const SNAPSHOT_FILE_PATH = PathUtils.join(
  SNAPSHOT_DIR_PATH,
  "sidebar-state.json"
);

async function clearSnapshotFile() {
  for (const path of [
    SNAPSHOT_FILE_PATH,
    `${SNAPSHOT_FILE_PATH}.tmp`,
    SNAPSHOT_DIR_PATH,
  ]) {
    if (!(await IOUtils.exists(path))) {
      continue;
    }
    try {
      await IOUtils.remove(path, {
        recursive: path === SNAPSHOT_DIR_PATH,
      });
    } catch {
      // Ignore cleanup failures for paths that may already be gone.
    }
  }
}

async function writeSnapshot(snapshot) {
  await IOUtils.makeDirectory(SNAPSHOT_DIR_PATH, {
    createAncestors: true,
    ignoreExisting: true,
  });
  await IOUtils.writeJSON(SNAPSHOT_FILE_PATH, snapshot, {
    flush: true,
    tmpPath: `${SNAPSHOT_FILE_PATH}.tmp`,
  });
}

async function withSidebarSyncWindow(task) {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenStartup.promiseInitialized;
  await win.gZenWorkspaces.promiseInitialized;
  await win.gZenSidebarProfileSync.init(win);

  try {
    await task(win);
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
}

function simplifyTabEntry(entry) {
  return {
    type: "tab",
    url: entry.url,
    userContextId: entry.userContextId,
    sublabel: entry.sublabel,
  };
}

function simplifyPinnedEntries(entries) {
  return entries.map(entry => {
    if (entry.type === "folder") {
      return {
        type: "folder",
        id: entry.id,
        name: entry.name,
        collapsed: entry.collapsed,
        userIcon: entry.userIcon,
        entries: simplifyPinnedEntries(entry.entries),
      };
    }

    return simplifyTabEntry(entry);
  });
}

function simplifySnapshot(snapshot) {
  return {
    workspaces: snapshot.workspaces.map(workspace => ({
      uuid: workspace.uuid,
      name: workspace.name,
      icon: workspace.icon,
      containerTabId: workspace.containerTabId,
      hasCollapsedPinnedTabs: workspace.hasCollapsedPinnedTabs,
    })),
    essentials: snapshot.essentials.map(entry => simplifyTabEntry(entry)),
    pinned: snapshot.pinned.map(workspace => ({
      workspaceUuid: workspace.workspaceUuid,
      entries: simplifyPinnedEntries(workspace.entries),
    })),
  };
}

function pinnedEntriesContainUrl(entries, url) {
  return entries.some(entry => {
    if (entry.type === "folder") {
      return pinnedEntriesContainUrl(entry.entries, url);
    }
    return entry.url === url;
  });
}

registerCleanupFunction(async () => {
  await clearSnapshotFile();
});

add_task(async function test_apply_snapshot_with_separate_essentials() {
  await clearSnapshotFile();
  await SpecialPowers.pushPrefEnv({
    set: [["zen.workspaces.separate-essentials", true]],
  });

  await withSidebarSyncWindow(async win => {
    const [workspace] = win.gZenWorkspaces.getWorkspaces();
    const snapshot = {
      schemaVersion: 2,
      profileKey: win.gZenSidebarProfileSync.profileKey,
      updatedAt: Date.now() + 1000,
      workspaces: [
        {
          uuid: workspace.uuid,
          name: workspace.name,
          icon: workspace.icon,
          theme: workspace.theme ?? null,
          containerTabId: workspace.containerTabId ?? 0,
          hasCollapsedPinnedTabs: false,
        },
      ],
      essentials: [
        {
          type: "tab",
          url: "https://example.com/default-essential/",
          title: "Default Essential",
          userContextId: 0,
          sublabel: null,
        },
        {
          type: "tab",
          url: "https://example.com/container-essential/",
          title: "Container Essential",
          userContextId: 1,
          sublabel: null,
        },
      ],
      pinned: [
        {
          workspaceUuid: workspace.uuid,
          entries: [
            {
              type: "tab",
              url: "https://example.com/workspace-pinned/",
              title: "Workspace Pinned",
              userContextId: 0,
              sublabel: null,
            },
          ],
        },
      ],
    };

    ok(
      await win.gZenSidebarProfileSync.applySnapshot(snapshot),
      "The snapshot should be applied when essentials are separated"
    );

    await TestUtils.waitForCondition(() => {
      const exported = win.gZenSidebarProfileSync.exportSnapshot();
      return (
        JSON.stringify(simplifySnapshot(exported)) ===
        JSON.stringify(simplifySnapshot(snapshot))
      );
    }, "The snapshot should settle with separate essentials enabled");

    const exported = win.gZenSidebarProfileSync.exportSnapshot();
    Assert.deepEqual(
      simplifySnapshot(exported),
      simplifySnapshot(snapshot),
      "Separated essentials should preserve the synced sidebar snapshot"
    );

    const defaultEssential = win.gBrowser.tabs.find(
      tab =>
        tab.hasAttribute("zen-essential") &&
        tab.getAttribute("usercontextid") === "0" &&
        tab.linkedBrowser?.currentURI?.spec ===
          "https://example.com/default-essential/"
    );
    const containerEssential = win.gBrowser.tabs.find(
      tab =>
        tab.hasAttribute("zen-essential") &&
        tab.getAttribute("usercontextid") === "1" &&
        tab.linkedBrowser?.currentURI?.spec ===
          "https://example.com/container-essential/"
    );

    ok(defaultEssential, "The default essential tab should exist");
    ok(containerEssential, "The container essential tab should exist");
    Assert.equal(
      defaultEssential.parentNode.getAttribute("container"),
      "0",
      "The default essential should stay in the default essentials section"
    );
    Assert.equal(
      containerEssential.parentNode.getAttribute("container"),
      "1",
      "The container essential should stay in its matching essentials section"
    );
  });

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_apply_snapshot_syncs_folders_and_sidebar_state() {
  await clearSnapshotFile();

  await withSidebarSyncWindow(async win => {
    const [primaryWorkspace] = win.gZenWorkspaces.getWorkspaces();
    const secondaryWorkspace = await win.gZenWorkspaces.createAndSaveWorkspace(
      "Local Secondary"
    );

    await win.gZenWorkspaces.changeWorkspaceWithID(primaryWorkspace.uuid);

    const normalTab = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      "https://example.com/normal-tab/",
      true
    );

    const localEssential = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      "https://example.com/local-essential/",
      true
    );
    win.gBrowser.pinTab(localEssential);
    win.gZenPinnedTabManager.addToEssentials(localEssential);

    const localPinned = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      "https://example.com/local-pinned/",
      true
    );
    win.gBrowser.pinTab(localPinned);

    const localFolderTab = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      "https://example.com/local-folder-tab/",
      true
    );
    win.gBrowser.pinTab(localFolderTab);
    await win.gZenFolders.createFolder([localFolderTab], {
      renameFolder: false,
      label: "Local Folder",
      workspaceId: primaryWorkspace.uuid,
    });

    const snapshot = {
      schemaVersion: 2,
      profileKey: win.gZenSidebarProfileSync.profileKey,
      updatedAt: Date.now() + 1000,
      workspaces: [
        {
          uuid: secondaryWorkspace.uuid,
          name: "Remote Secondary",
          icon: "B",
          theme: secondaryWorkspace.theme ?? null,
          containerTabId: secondaryWorkspace.containerTabId ?? 0,
          hasCollapsedPinnedTabs: false,
        },
        {
          uuid: primaryWorkspace.uuid,
          name: "Remote Primary",
          icon: "A",
          theme: primaryWorkspace.theme ?? null,
          containerTabId: primaryWorkspace.containerTabId ?? 0,
          hasCollapsedPinnedTabs: false,
        },
      ],
      essentials: [
        {
          type: "tab",
          url: "https://example.com/remote-essential/",
          title: "Remote Essential",
          userContextId: 0,
          sublabel: "Synced",
        },
      ],
      pinned: [
        {
          workspaceUuid: secondaryWorkspace.uuid,
          entries: [
            {
              type: "folder",
              id: "remote-folder",
              name: "Admin",
              collapsed: false,
              userIcon: null,
              entries: [
                {
                  type: "tab",
                  url: "https://example.com/local-pinned/",
                  title: "Moved Pinned",
                  userContextId: 0,
                  sublabel: null,
                },
                {
                  type: "folder",
                  id: "remote-subfolder",
                  name: "Nested",
                  collapsed: true,
                  userIcon: null,
                  entries: [
                    {
                      type: "tab",
                      url: "https://example.com/nested-pinned/",
                      title: "Nested Pinned",
                      userContextId: 0,
                      sublabel: null,
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          workspaceUuid: primaryWorkspace.uuid,
          entries: [
            {
              type: "tab",
              url: "https://example.com/new-pinned/",
              title: "New Pinned",
              userContextId: 0,
              sublabel: null,
            },
          ],
        },
      ],
    };

    ok(
      await win.gZenSidebarProfileSync.applySnapshot(snapshot),
      "The snapshot should be applied"
    );

    await TestUtils.waitForCondition(() => {
      const exported = win.gZenSidebarProfileSync.exportSnapshot();
      return (
        JSON.stringify(simplifySnapshot(exported)) ===
        JSON.stringify(simplifySnapshot(snapshot))
      );
    }, "The sidebar snapshot should settle after applying");

    const exported = win.gZenSidebarProfileSync.exportSnapshot();
    Assert.deepEqual(
      simplifySnapshot(exported),
      simplifySnapshot(snapshot),
      "Workspaces, essentials, pinned tabs and folders should match the snapshot"
    );

    ok(!normalTab.pinned, "The regular session tab should stay unpinned");
    ok(!normalTab.closing, "The regular session tab should remain open");
    ok(
      !exported.essentials.some(
        entry => entry.url === "https://example.com/local-essential/"
      ),
      "Essentials missing from the snapshot should be removed"
    );
    ok(
      !pinnedEntriesContainUrl(
        exported.pinned.flatMap(workspace => workspace.entries),
        "https://example.com/local-folder-tab/"
      ),
      "Pinned tabs removed from the snapshot should disappear with their old folder"
    );
  });
});

add_task(async function test_external_updates_ignore_profile_mismatch_and_older_data() {
  await clearSnapshotFile();

  await withSidebarSyncWindow(async win => {
    const baseline = win.gZenSidebarProfileSync.exportSnapshot();
    const baselineName = baseline.workspaces[0].name;
    const appliedAt = Date.now() + 2000;

    ok(
      await win.gZenSidebarProfileSync.applySnapshot({
        ...baseline,
        updatedAt: appliedAt,
      }),
      "The baseline snapshot should establish a last-applied timestamp"
    );

    const mismatchedProfileSnapshot = {
      ...baseline,
      profileKey: `${baseline.profileKey}-other`,
      updatedAt: appliedAt + 1000,
      workspaces: baseline.workspaces.map((workspace, index) =>
        index === 0 ? { ...workspace, name: "Wrong Profile" } : workspace
      ),
    };
    await writeSnapshot(mismatchedProfileSnapshot);

    ok(
      !(await win.gZenSidebarProfileSync.checkForExternalUpdate()),
      "Snapshots for a different profile should be ignored"
    );
    Assert.equal(
      win.gZenSidebarProfileSync.exportSnapshot().workspaces[0].name,
      baselineName,
      "A profile mismatch must not change local workspaces"
    );

    const olderSnapshot = {
      ...baseline,
      updatedAt: appliedAt - 1,
      workspaces: baseline.workspaces.map((workspace, index) =>
        index === 0 ? { ...workspace, name: "Older Snapshot" } : workspace
      ),
    };
    await writeSnapshot(olderSnapshot);

    ok(
      !(await win.gZenSidebarProfileSync.checkForExternalUpdate()),
      "Older snapshots should be ignored"
    );
    Assert.equal(
      win.gZenSidebarProfileSync.exportSnapshot().workspaces[0].name,
      baselineName,
      "An older snapshot must not overwrite the newer local state"
    );
  });
});
