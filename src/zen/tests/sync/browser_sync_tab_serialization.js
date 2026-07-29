/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSyncStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSyncManager.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "resource://gre/modules/ContextualIdentityService.sys.mjs"
);

function emptySyncItems() {
  return {
    spaces: [],
    tabs: [],
    folders: [],
    containers: [],
    splits: [],
    shortcuts: [],
  };
}

add_task(function test_serializes_only_durable_pinned_state() {
  const result = ZenSyncStore.createSyncableTabData(
    {
      zenSyncId: "tab-1",
      pinned: true,
      zenEssential: true,
      zenWorkspace: "ignored-for-essential",
      userContextId: 3,
      image: "current-icon",
      index: 2,
      entries: [
        { url: "https://example.com/first", title: "First" },
        {
          url: "https://example.com/current",
          title: "Current",
          formdata: { id: { secret: "not-synced" } },
          scroll: "0,500",
        },
      ],
      _zenPinnedInitialState: {
        entry: {
          url: "https://example.com/pinned",
          title: "Pinned",
          formdata: { id: { secret: "not-synced" } },
        },
        image: "pinned-icon",
      },
    },
    { position: 4 }
  );

  Assert.deepEqual(
    result.entries,
    [{ url: "https://example.com/pinned", title: "Pinned" }],
    "Only the original pinned entry is serialized"
  );
  Assert.deepEqual(
    result._zenPinnedInitialState,
    {
      entry: { url: "https://example.com/pinned", title: "Pinned" },
      image: "pinned-icon",
    },
    "The reset target remains available on every device"
  );
  Assert.equal(result.index, 1, "No browsing history is transferred");
  Assert.equal(result.image, "pinned-icon", "The pinned icon is retained");
  Assert.equal(result.position, 4, "Sidebar ordering is retained");
  Assert.equal(
    result.zenWorkspace,
    null,
    "Essentials are workspace-independent"
  );
  Assert.ok(
    /^[0-9a-f-]{36}$/i.test(result.containerSyncId),
    "Container identity is opaque on the wire"
  );
  Assert.ok(
    !("userContextId" in result),
    "Device-local numeric container IDs are not serialized"
  );
  Assert.equal(
    ZenSyncStore.getContainerSyncId(3),
    result.containerSyncId,
    "Container mappings remain stable within the profile"
  );
});

add_task(function test_rejects_non_durable_tabs() {
  Assert.equal(
    ZenSyncStore.createSyncableTabData({
      zenSyncId: "ordinary-tab",
      pinned: false,
      entries: [{ url: "https://example.com" }],
    }),
    null,
    "Ordinary tabs are never uploaded"
  );
  Assert.equal(
    ZenSyncStore.createSyncableTabData({
      zenSyncId: "live-folder-item",
      pinned: true,
      zenLiveFolderItemId: "generated-item",
      entries: [{ url: "https://example.com" }],
    }),
    null,
    "Generated live-folder tabs are never uploaded"
  );
  for (const url of [
    "javascript:alert(document.domain)",
    "file:///local/private-file",
    "chrome://browser/content/browser.xhtml",
  ]) {
    Assert.equal(
      ZenSyncStore.createSyncableTabData({
        zenSyncId: `unsafe-${url}`,
        pinned: true,
        entries: [{ url }],
      }),
      null,
      `${url} is not accepted as a cross-device pin`
    );
  }
});

add_task(function test_serializes_only_zen_shortcut_bindings() {
  const result = ZenSyncStore.createSyncableShortcutData({
    shortcuts: [
      {
        id: "zen-compact-mode-toggle",
        key: "s",
        keycode: "",
        modifiers: {
          control: false,
          alt: true,
          shift: false,
          meta: false,
          accel: false,
        },
        action: "code:Services.appinfo.name",
        group: "zen-compact-mode",
        disabled: false,
      },
      {
        id: "key_privatebrowsing",
        key: "n",
        modifiers: { accel: true, shift: true },
      },
    ],
  });

  Assert.deepEqual(
    result,
    [
      {
        id: "zen-compact-mode-toggle",
        key: "s",
        keycode: "",
        modifiers: {
          control: false,
          alt: true,
          shift: false,
          meta: false,
          accel: false,
        },
        disabled: false,
      },
    ],
    "Only minimal Zen-owned bindings are serialized"
  );
  Assert.ok(
    !("action" in result[0]),
    "Executable shortcut actions never cross devices"
  );
});

add_task(async function test_container_aliases_and_tombstones_are_safe() {
  const name = `Zen Sync test ${Services.uuid.generateUUID()}`;
  const first = ContextualIdentityService.create(name, "circle", "blue");
  const second = ContextualIdentityService.create(name, "circle", "blue");

  registerCleanupFunction(() => {
    ContextualIdentityService.remove(first.userContextId);
    ContextualIdentityService.remove(second.userContextId);
  });

  Assert.equal(
    ZenSyncStore.getContainerSemanticOrdinal(first.userContextId),
    0,
    "The first otherwise-identical container has ordinal zero"
  );
  Assert.equal(
    ZenSyncStore.getContainerSemanticOrdinal(second.userContextId),
    1,
    "Intentional duplicate containers remain distinct"
  );

  const firstRemoteId = Services.uuid.generateUUID().toString().slice(1, -1);
  const secondRemoteId = Services.uuid.generateUUID().toString().slice(1, -1);
  const pulled = emptySyncItems();
  pulled.containers = [
    {
      syncId: firstRemoteId,
      name,
      icon: "circle",
      color: "blue",
      semanticOrdinal: 0,
    },
    {
      syncId: secondRemoteId,
      name,
      icon: "circle",
      color: "blue",
      semanticOrdinal: 1,
    },
  ];
  await ZenSyncStore.applyIncomingBatch(pulled, emptySyncItems());

  Assert.equal(
    ZenSyncStore.resolveLocalContainerId(firstRemoteId),
    first.userContextId,
    "The first remote identity aliases the first local container"
  );
  Assert.equal(
    ZenSyncStore.resolveLocalContainerId(secondRemoteId),
    second.userContextId,
    "The second remote identity aliases the second local container"
  );

  const removals = emptySyncItems();
  removals.containers = [{ syncId: firstRemoteId }, { syncId: secondRemoteId }];
  await ZenSyncStore.applyIncomingBatch(emptySyncItems(), removals);

  Assert.ok(
    ContextualIdentityService.getPublicIdentityFromId(first.userContextId),
    "A remote tombstone does not delete local container data"
  );
  Assert.ok(
    ContextualIdentityService.getPublicIdentityFromId(second.userContextId),
    "Every intentional local container remains available"
  );
});

add_task(async function test_remote_folder_delete_preserves_local_pin() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  const folder = await gZenFolders.createFolder([tab], {
    label: "Sync safety test",
    renameFolder: false,
  });
  const removals = emptySyncItems();
  removals.folders = [{ id: folder.id }];

  await ZenSyncStore.applyIncomingBatch(emptySyncItems(), removals);

  Assert.ok(!tab.closing, "The local pinned tab is not closed");
  Assert.ok(!tab.group?.isZenFolder, "The surviving tab is unpacked safely");
  Assert.ok(!folder.isConnected, "Only the remotely deleted folder is gone");

  ZenSyncStore.takePostApplyItems();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_remote_space_delete_rehomes_local_tab() {
  const fallbackSpace = gZenWorkspaces.getActiveWorkspace();
  const removedSpace = await gZenWorkspaces.createAndSaveWorkspace(
    "Sync removal safety test"
  );
  await gZenWorkspaces.changeWorkspace(removedSpace);
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  const removals = emptySyncItems();
  removals.spaces = [{ uuid: removedSpace.uuid }];

  await ZenSyncStore.applyIncomingBatch(emptySyncItems(), removals);

  Assert.ok(!tab.closing, "The local ordinary tab is not closed");
  Assert.equal(
    tab.getAttribute("zen-workspace-id"),
    fallbackSpace.uuid,
    "The local tab moves to a surviving Space"
  );
  Assert.ok(
    !gZenWorkspaces
      .getWorkspaces()
      .some(space => space.uuid === removedSpace.uuid),
    "The remote Space tombstone still applies"
  );

  ZenSyncStore.takePostApplyItems();
  BrowserTestUtils.removeTab(tab);
});
