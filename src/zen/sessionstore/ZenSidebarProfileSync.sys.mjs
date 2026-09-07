/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This module intentionally syncs only sidebar-managed state via a profile
// snapshot file so transports like Syncthing can mirror it without changing
// Firefox Sync or widening the restore surface to full sessions.
const SNAPSHOT_SCHEMA_VERSION = 2;
const LEGACY_SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_DIR_NAME = "zen-sync";
const SNAPSHOT_FILE_NAME = "sidebar-state.json";
const EXPORT_DEBOUNCE_MS = 400;
const EXTERNAL_POLL_INTERVAL_MS = 5000;

function cloneJSON(value) {
  if (value === null || typeof value !== "object") {
    return value ?? null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function toInteger(value, fallback = 0) {
  const normalized =
    typeof value === "string" ? parseInt(value, 10) : value;
  return Number.isInteger(normalized) ? normalized : fallback;
}

export class ZenSidebarProfileSync {
  #window = null;
  #initialized = false;
  #initPromise = null;
  #mutationObserver = null;
  #pollTimer = 0;
  #exportTimer = 0;
  #applyingSnapshot = false;
  #suspendedExports = 0;
  #lastComparableSnapshot = null;
  #lastSeenFileHash = null;
  #lastSeenFileMtime = 0;
  #lastAppliedUpdatedAt = 0;
  #lastWrittenUpdatedAt = 0;

  get profileKey() {
    return PathUtils.filename(PathUtils.profileDir);
  }

  get snapshotDirPath() {
    return PathUtils.join(PathUtils.profileDir, SNAPSHOT_DIR_NAME);
  }

  get snapshotFilePath() {
    return PathUtils.join(this.snapshotDirPath, SNAPSHOT_FILE_NAME);
  }

  init(window) {
    if (this.#initPromise) {
      return this.#initPromise;
    }

    this.#window = window;
    this.#initPromise = this.#initInternal();
    return this.#initPromise;
  }

  async #initInternal() {
    if (
      this.#initialized ||
      !this.#window?.gZenWorkspaces ||
      this.#window.gZenWorkspaces.privateWindowOrDisabled
    ) {
      return;
    }

    this.#initialized = true;
    this.#mutationObserver = new this.#window.MutationObserver(() => {
      this.scheduleExport("mutation");
    });

    this.#window.addEventListener("unload", this, { once: true });
    for (const eventName of [
      "ZenWorkspaceDataChanged",
      "ZenFolderChangedWorkspace",
      "TabPinned",
      "TabUnpinned",
      "TabAddedToEssentials",
      "TabRemovedFromEssentials",
      "ZenTabLabelChanged",
      "TabGroupCreate",
      "TabGroupRemoved",
      "TabGroupMoved",
      "TabGroupUpdate",
      "TabGroupCollapse",
      "TabGroupExpand",
    ]) {
      this.#window.addEventListener(eventName, this, true);
    }

    const hadSnapshotFile = await IOUtils.exists(this.snapshotFilePath);
    await this.checkForExternalUpdate({ forceRead: true });
    this.#refreshMutationObservers();
    this.#startPolling();

    if (!hadSnapshotFile) {
      this.scheduleExport("startup");
    }
  }

  handleEvent(event) {
    switch (event.type) {
      case "unload":
        this.#shutdown();
        break;
      case "ZenWorkspaceDataChanged":
        this.#refreshMutationObservers();
        this.scheduleExport(event.type);
        break;
      default:
        this.scheduleExport(event.type);
        break;
    }
  }

  exportSnapshot() {
    return {
      ...this.#buildSnapshotBody(),
      updatedAt: Date.now(),
    };
  }

  scheduleExport(_reason = "unknown") {
    if (
      !this.#initialized ||
      this.#suspendedExports > 0 ||
      this.#applyingSnapshot ||
      this.#window?.closed
    ) {
      return;
    }

    clearTimeout(this.#exportTimer);
    this.#exportTimer = setTimeout(() => {
      this.#exportSnapshotToFile().catch(error => {
        console.error("ZenSidebarProfileSync: Failed to export snapshot", error);
      });
    }, EXPORT_DEBOUNCE_MS);
  }

  async checkForExternalUpdate(options = {}) {
    if (!this.#initialized || this.#window?.closed) {
      return false;
    }

    const { forceRead = false } = options;
    let fileInfo;
    try {
      fileInfo = await IOUtils.stat(this.snapshotFilePath);
    } catch (error) {
      if (DOMException.isInstance(error) && error.name === "NotFoundError") {
        this.#lastSeenFileHash = null;
        this.#lastSeenFileMtime = 0;
        return false;
      }
      throw error;
    }

    const lastModified = fileInfo.lastModified ?? 0;
    if (!forceRead && lastModified === this.#lastSeenFileMtime) {
      return false;
    }

    let snapshot;
    try {
      snapshot = await IOUtils.readJSON(this.snapshotFilePath);
    } catch (error) {
      console.error("ZenSidebarProfileSync: Failed to read snapshot", error);
      this.#lastSeenFileMtime = lastModified;
      this.#lastSeenFileHash = null;
      return false;
    }

    const normalized = this.#normalizeSnapshot(snapshot);
    const fileHash = normalized
      ? JSON.stringify(normalized)
      : JSON.stringify(snapshot ?? null);

    if (!forceRead && fileHash === this.#lastSeenFileHash) {
      this.#lastSeenFileMtime = lastModified;
      return false;
    }

    this.#lastSeenFileMtime = lastModified;
    this.#lastSeenFileHash = fileHash;

    if (!normalized || normalized.profileKey !== this.profileKey) {
      return false;
    }

    const comparable = this.#getComparableSnapshot(normalized);
    const latestKnownUpdate = Math.max(
      this.#lastAppliedUpdatedAt,
      this.#lastWrittenUpdatedAt
    );

    if (
      comparable === this.#lastComparableSnapshot &&
      normalized.updatedAt <= latestKnownUpdate
    ) {
      return false;
    }

    if (normalized.updatedAt < latestKnownUpdate) {
      return false;
    }

    return this.applySnapshot(normalized);
  }

  async applySnapshot(snapshot) {
    const normalized = this.#normalizeSnapshot(snapshot);
    if (!normalized || normalized.profileKey !== this.profileKey) {
      return false;
    }

    const latestKnownUpdate = Math.max(
      this.#lastAppliedUpdatedAt,
      this.#lastWrittenUpdatedAt
    );
    if (normalized.updatedAt < latestKnownUpdate) {
      return false;
    }

    const comparable = this.#getComparableSnapshot(normalized);
    if (
      !this.#applyingSnapshot &&
      comparable === this.#lastComparableSnapshot &&
      normalized.updatedAt <= latestKnownUpdate
    ) {
      this.#lastAppliedUpdatedAt = Math.max(
        this.#lastAppliedUpdatedAt,
        normalized.updatedAt
      );
      return false;
    }

    this.#applyingSnapshot = true;
    this.#suspendedExports++;
    try {
      await this.#reconcileWorkspaces(normalized.workspaces);
      await this.#reconcileSidebarState(normalized);
      this.#lastComparableSnapshot = comparable;
      this.#lastAppliedUpdatedAt = Math.max(
        this.#lastAppliedUpdatedAt,
        normalized.updatedAt
      );
      this.#refreshMutationObservers();
      return true;
    } finally {
      this.#applyingSnapshot = false;
      this.#suspendedExports = Math.max(0, this.#suspendedExports - 1);
    }
  }

  #shutdown() {
    clearInterval(this.#pollTimer);
    clearTimeout(this.#exportTimer);
    this.#pollTimer = 0;
    this.#exportTimer = 0;
    this.#mutationObserver?.disconnect();
  }

  #startPolling() {
    clearInterval(this.#pollTimer);
    this.#pollTimer = setInterval(() => {
      this.checkForExternalUpdate().catch(error => {
        console.error(
          "ZenSidebarProfileSync: Failed to process external update",
          error
        );
      });
    }, EXTERNAL_POLL_INTERVAL_MS);
  }

  #refreshMutationObservers() {
    if (!this.#mutationObserver) {
      return;
    }

    this.#mutationObserver.disconnect();

    const essentialsContainers = this.#window.document.querySelectorAll(
      "#zen-essentials .zen-essentials-container:not([cloned])"
    );
    for (const container of essentialsContainers) {
      this.#observeContainer(container);
    }

    for (const workspace of this.#window.gZenWorkspaces.getWorkspaces()) {
      const workspaceElement = this.#window.gZenWorkspaces.workspaceElement(
        workspace.uuid
      );
      const pinnedContainer = workspaceElement?.pinnedTabsContainer;
      if (pinnedContainer) {
        this.#observeContainer(pinnedContainer);
      }
    }
  }

  #observeContainer(container) {
    this.#mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }

  #buildSnapshotBody() {
    const workspaces = this.#window.gZenWorkspaces.getWorkspaces().map(
      workspace => {
        const workspaceElement = this.#window.gZenWorkspaces.workspaceElement(
          workspace.uuid
        );
        return {
          uuid: workspace.uuid,
          name: typeof workspace.name === "string" ? workspace.name : "Space",
          icon: typeof workspace.icon === "string" ? workspace.icon : "",
          theme: cloneJSON(workspace.theme ?? null),
          containerTabId: toInteger(workspace.containerTabId, 0),
          hasCollapsedPinnedTabs: Boolean(
            workspaceElement?.hasCollapsedPinnedTabs ??
              workspace.hasCollapsedPinnedTabs
          ),
        };
      }
    );

    const essentials = [];
    for (const tab of this.#getManagedEssentialTabs()) {
      const serialized = this.#serializeTabEntry(tab);
      if (serialized) {
        essentials.push(serialized);
      }
    }

    const pinned = workspaces.map(workspace => ({
      workspaceUuid: workspace.uuid,
      entries: this.#serializePinnedEntries(workspace.uuid),
    }));

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      profileKey: this.profileKey,
      workspaces,
      essentials,
      pinned,
    };
  }

  async #exportSnapshotToFile() {
    const snapshotBody = this.#buildSnapshotBody();
    const comparable = JSON.stringify(snapshotBody);

    if (comparable === this.#lastComparableSnapshot) {
      return false;
    }

    const snapshot = {
      ...snapshotBody,
      updatedAt: Date.now(),
    };

    await IOUtils.makeDirectory(this.snapshotDirPath, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeJSON(this.snapshotFilePath, snapshot, {
      flush: true,
      tmpPath: `${this.snapshotFilePath}.tmp`,
    });

    let lastModified = Date.now();
    try {
      lastModified = (await IOUtils.stat(this.snapshotFilePath)).lastModified;
    } catch {
      // Ignore stat failures after a successful write.
    }

    this.#lastComparableSnapshot = comparable;
    this.#lastWrittenUpdatedAt = snapshot.updatedAt;
    this.#lastSeenFileMtime = lastModified;
    this.#lastSeenFileHash = JSON.stringify(snapshot);
    return true;
  }

  #serializePinnedEntries(workspaceUuid) {
    const workspaceElement = this.#window.gZenWorkspaces.workspaceElement(
      workspaceUuid
    );
    const pinnedContainer = workspaceElement?.pinnedTabsContainer;
    if (!pinnedContainer) {
      return [];
    }

    const entries = [];
    for (const child of pinnedContainer.children) {
      const serialized = this.#serializePinnedChild(child, workspaceUuid);
      if (serialized) {
        entries.push(serialized);
      }
    }
    return entries;
  }

  #serializePinnedChild(item, workspaceUuid) {
    if (this.#isManagedFolder(item)) {
      return this.#serializeFolderEntry(item, workspaceUuid);
    }

    if (this.#isManagedPinnedTab(item, workspaceUuid)) {
      return this.#serializeTabEntry(item);
    }

    return null;
  }

  #serializeFolderEntry(folder, workspaceUuid) {
    const entries = [];
    for (const child of folder.allItems) {
      const serialized = this.#serializePinnedChild(child, workspaceUuid);
      if (serialized) {
        entries.push(serialized);
      }
    }

    return {
      type: "folder",
      id: folder.id,
      name: folder.label || "New Folder",
      collapsed: Boolean(folder.collapsed),
      userIcon: folder.iconURL || null,
      entries,
    };
  }

  #serializeTabEntry(tab) {
    const url = this.#getTabUrl(tab);
    if (!url) {
      return null;
    }

    return {
      type: "tab",
      url,
      title: tab.label || null,
      userContextId: this.#getUserContextId(tab),
      sublabel: tab.getAttribute("zen-show-sublabel") || null,
    };
  }

  #getManagedSidebarTabs() {
    return Array.from(
      this.#window.gBrowser.tabContainer.querySelectorAll("tab[pinned]")
    ).filter(tab => this.#isManagedSidebarTab(tab));
  }

  #getManagedEssentialTabs() {
    const tabs = [];
    const essentialsContainers = this.#window.document.querySelectorAll(
      "#zen-essentials .zen-essentials-container:not([cloned])"
    );
    for (const container of essentialsContainers) {
      for (const child of container.children) {
        if (this.#isManagedEssentialTab(child)) {
          tabs.push(child);
        }
      }
    }
    return tabs;
  }

  #isManagedSidebarTab(tab) {
    const group = tab?.group;
    return Boolean(
      tab &&
        this.#window.gBrowser.isTab(tab) &&
        tab.pinned &&
        !tab.closing &&
        !tab.hasAttribute("zen-empty-tab") &&
        !tab.hasAttribute("zen-glance-tab") &&
        !tab.hasAttribute("zen-live-folder-item-id") &&
        (!group || group.isZenFolder) &&
        !group?.isLiveFolder &&
        !group?.hasAttribute("split-view-group")
    );
  }

  #isManagedEssentialTab(tab) {
    return this.#isManagedSidebarTab(tab) && tab.hasAttribute("zen-essential");
  }

  #isManagedPinnedTab(tab, workspaceUuid = null) {
    if (!this.#isManagedSidebarTab(tab) || tab.hasAttribute("zen-essential")) {
      return false;
    }

    return (
      workspaceUuid === null || this.#getWorkspaceIdForTab(tab) === workspaceUuid
    );
  }

  #isManagedFolder(folder) {
    return Boolean(folder?.isZenFolder && !folder.isLiveFolder);
  }

  #getTabUrl(tab) {
    try {
      const state = JSON.parse(this.#window.SessionStore.getTabState(tab));
      const entries = state.entries || [];
      const activeIndex = Math.max((state.index || entries.length) - 1, 0);
      return (
        entries[activeIndex]?.url ||
        entries[entries.length - 1]?.url ||
        tab.linkedBrowser?.currentURI?.spec ||
        null
      );
    } catch {
      return tab.linkedBrowser?.currentURI?.spec || null;
    }
  }

  #getUserContextId(tab) {
    return toInteger(tab.getAttribute("usercontextid"), 0);
  }

  #getWorkspaceIdForTab(tab) {
    return tab.getAttribute("zen-workspace-id");
  }

  #normalizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }

    switch (snapshot.schemaVersion) {
      case SNAPSHOT_SCHEMA_VERSION:
        return this.#normalizeSnapshotV2(snapshot);
      case LEGACY_SNAPSHOT_SCHEMA_VERSION:
        return this.#normalizeSnapshotV1(snapshot);
      default:
        return null;
    }
  }

  #normalizeSnapshotV2(snapshot) {
    const profileKey =
      typeof snapshot.profileKey === "string" ? snapshot.profileKey : "";
    const updatedAt = Number(snapshot.updatedAt) || 0;

    const workspaces = Array.isArray(snapshot.workspaces)
      ? snapshot.workspaces
          .map(workspace => this.#normalizeWorkspace(workspace))
          .filter(Boolean)
      : [];
    if (!workspaces.length) {
      return null;
    }

    const knownWorkspaceIds = new Set(workspaces.map(workspace => workspace.uuid));
    const essentials = Array.isArray(snapshot.essentials)
      ? snapshot.essentials
          .map(entry => this.#normalizeTabEntry(entry))
          .filter(Boolean)
      : [];

    const pinnedByWorkspace = new Map(
      workspaces.map(workspace => [workspace.uuid, []])
    );
    for (const item of Array.isArray(snapshot.pinned) ? snapshot.pinned : []) {
      const normalized = this.#normalizePinnedWorkspace(item, knownWorkspaceIds);
      if (normalized) {
        pinnedByWorkspace.set(normalized.workspaceUuid, normalized.entries);
      }
    }

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      profileKey,
      updatedAt,
      workspaces,
      essentials,
      pinned: workspaces.map(workspace => ({
        workspaceUuid: workspace.uuid,
        entries: pinnedByWorkspace.get(workspace.uuid) || [],
      })),
    };
  }

  #normalizeSnapshotV1(snapshot) {
    const profileKey =
      typeof snapshot.profileKey === "string" ? snapshot.profileKey : "";
    const updatedAt = Number(snapshot.updatedAt) || 0;

    const workspaces = Array.isArray(snapshot.workspaces)
      ? snapshot.workspaces
          .map(workspace => this.#normalizeWorkspace(workspace))
          .filter(Boolean)
      : [];
    if (!workspaces.length) {
      return null;
    }

    const knownWorkspaceIds = new Set(workspaces.map(workspace => workspace.uuid));
    const essentials = [];
    const pinnedByWorkspace = new Map(
      workspaces.map(workspace => [workspace.uuid, []])
    );

    for (const item of Array.isArray(snapshot.items) ? snapshot.items : []) {
      const normalized = this.#normalizeLegacyItem(item, knownWorkspaceIds);
      if (!normalized) {
        continue;
      }

      if (normalized.essential) {
        essentials.push(normalized.entry);
      } else {
        pinnedByWorkspace.get(normalized.workspaceUuid)?.push(normalized.entry);
      }
    }

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      profileKey,
      updatedAt,
      workspaces,
      essentials,
      pinned: workspaces.map(workspace => ({
        workspaceUuid: workspace.uuid,
        entries: pinnedByWorkspace.get(workspace.uuid) || [],
      })),
    };
  }

  #normalizeWorkspace(workspace) {
    if (!workspace || typeof workspace !== "object") {
      return null;
    }

    const uuid =
      typeof workspace.uuid === "string" && workspace.uuid
        ? workspace.uuid
        : null;
    if (!uuid) {
      return null;
    }

    return {
      uuid,
      name: typeof workspace.name === "string" ? workspace.name : "Space",
      icon: typeof workspace.icon === "string" ? workspace.icon : "",
      theme: cloneJSON(workspace.theme ?? null),
      containerTabId: toInteger(workspace.containerTabId, 0),
      hasCollapsedPinnedTabs: Boolean(workspace.hasCollapsedPinnedTabs),
    };
  }

  #normalizeLegacyItem(item, knownWorkspaceIds) {
    if (!item || typeof item !== "object" || typeof item.url !== "string") {
      return null;
    }

    const essential = Boolean(item.essential);
    const workspaceUuid = essential
      ? null
      : typeof item.workspaceUuid === "string" &&
          knownWorkspaceIds.has(item.workspaceUuid)
        ? item.workspaceUuid
        : null;

    if (!essential && !workspaceUuid) {
      return null;
    }

    return {
      essential,
      workspaceUuid,
      entry: {
        type: "tab",
        url: item.url,
        title: typeof item.title === "string" ? item.title : null,
        userContextId: toInteger(item.userContextId, 0),
        sublabel: typeof item.sublabel === "string" ? item.sublabel : null,
      },
    };
  }

  #normalizePinnedWorkspace(item, knownWorkspaceIds) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.workspaceUuid !== "string" ||
      !knownWorkspaceIds.has(item.workspaceUuid)
    ) {
      return null;
    }

    return {
      workspaceUuid: item.workspaceUuid,
      entries: Array.isArray(item.entries)
        ? item.entries
            .map(entry => this.#normalizePinnedEntry(entry))
            .filter(Boolean)
        : [],
    };
  }

  #normalizePinnedEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    if (
      (entry.type === "tab" || !entry.type) &&
      typeof entry.url === "string" &&
      entry.url
    ) {
      return this.#normalizeTabEntry(entry);
    }

    if (
      (entry.type === "folder" || Array.isArray(entry.entries)) &&
      typeof entry.id === "string" &&
      entry.id
    ) {
      return this.#normalizeFolderEntry(entry);
    }

    return null;
  }

  #normalizeTabEntry(entry) {
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string") {
      return null;
    }

    return {
      type: "tab",
      url: entry.url,
      title: typeof entry.title === "string" ? entry.title : null,
      userContextId: toInteger(entry.userContextId, 0),
      sublabel: typeof entry.sublabel === "string" ? entry.sublabel : null,
    };
  }

  #normalizeFolderEntry(entry) {
    return {
      type: "folder",
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : "New Folder",
      collapsed: Boolean(entry.collapsed),
      userIcon:
        typeof entry.userIcon === "string" && entry.userIcon
          ? entry.userIcon
          : null,
      entries: Array.isArray(entry.entries)
        ? entry.entries
            .map(child => this.#normalizePinnedEntry(child))
            .filter(Boolean)
        : [],
    };
  }

  #getComparableSnapshot(snapshot) {
    return JSON.stringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      profileKey: snapshot.profileKey,
      workspaces: snapshot.workspaces,
      essentials: snapshot.essentials,
      pinned: snapshot.pinned,
    });
  }

  async #reconcileWorkspaces(workspaces) {
    await this.#window.gZenWorkspaces.propagateWorkspaces(
      workspaces.map(workspace => ({
        ...workspace,
        theme: cloneJSON(workspace.theme ?? null),
      }))
    );

    if (this.#window.gZenWindowSync?.propagateWorkspacesToAllWindows) {
      this.#window.gZenWindowSync.propagateWorkspacesToAllWindows(workspaces);
    }

    const activeWorkspaceId = workspaces.some(
      workspace => workspace.uuid === this.#window.gZenWorkspaces.activeWorkspace
    )
      ? this.#window.gZenWorkspaces.activeWorkspace
      : workspaces[0]?.uuid;

    if (activeWorkspaceId) {
      const activeWorkspace =
        this.#window.gZenWorkspaces.getWorkspaceFromId(activeWorkspaceId);
      if (activeWorkspace) {
        await this.#window.gZenWorkspaces.changeWorkspace(activeWorkspace, {
          alwaysChange: true,
        });
      }
    }

    for (const workspace of workspaces) {
      const workspaceElement = this.#window.gZenWorkspaces.workspaceElement(
        workspace.uuid
      );
      if (workspaceElement?.collapsiblePins) {
        workspaceElement.collapsiblePins.collapsed =
          workspace.hasCollapsedPinnedTabs;
      }
    }

    this.#window.dispatchEvent(
      new this.#window.CustomEvent("ZenWorkspacesUIUpdate", {
        bubbles: true,
        detail: { activeIndex: this.#window.gZenWorkspaces.activeWorkspace },
      })
    );
    this.#window.gZenWorkspaces.updateTabsContainers();
  }

  async #reconcileSidebarState(snapshot) {
    const availableTabs = [...this.#getManagedSidebarTabs()];
    const unmatchedTabs = new Set(availableTabs);

    const essentials = [];
    for (const entry of snapshot.essentials) {
      const tab =
        this.#takeMatchingTab(availableTabs, unmatchedTabs, entry, {
          essential: true,
          requirePlacementMatch: true,
        }) ||
        this.#takeMatchingTab(availableTabs, unmatchedTabs, entry, {
          essential: true,
          requirePlacementMatch: false,
        }) ||
        this.#openSnapshotTab(entry);

      essentials.push({ snapshot: entry, tab });
    }

    const pinned = snapshot.pinned.map(workspace => ({
      workspaceUuid: workspace.workspaceUuid,
      entries: this.#resolvePinnedEntries(
        workspace.entries,
        workspace.workspaceUuid,
        availableTabs,
        unmatchedTabs
      ),
    }));

    await this.#clearManagedFolders();

    const expectedTabsByContainer = new Map();
    for (const item of essentials) {
      await this.#ensureTabMatchesSnapshot(item.tab, {
        ...item.snapshot,
        essential: true,
        workspaceUuid: null,
      });

      if (!expectedTabsByContainer.has(item.snapshot.userContextId)) {
        expectedTabsByContainer.set(item.snapshot.userContextId, []);
      }
      expectedTabsByContainer.get(item.snapshot.userContextId).push(item.tab);
    }

    for (const [containerId, tabs] of expectedTabsByContainer) {
      const container = this.#window.gZenWorkspaces.getEssentialsSection(
        containerId
      );
      let previousNode = null;
      for (const tab of tabs) {
        this.#placeTabInContext(tab, {
          container,
          previousNode,
        });
        previousNode = tab;
      }
    }

    for (const workspace of pinned) {
      const workspaceElement = this.#window.gZenWorkspaces.workspaceElement(
        workspace.workspaceUuid
      );
      const container = workspaceElement?.pinnedTabsContainer;
      if (!container) {
        continue;
      }

      let previousNode = null;
      for (const entry of workspace.entries) {
        previousNode = await this.#placePinnedEntry(entry, {
          workspaceUuid: workspace.workspaceUuid,
          container,
          previousNode,
          parentFolder: null,
        });
      }
    }

    for (const tab of unmatchedTabs) {
      if (!this.#isManagedSidebarTab(tab)) {
        continue;
      }
      this.#window.gBrowser.removeTab(tab, {
        animate: false,
        closeWindowWithLastTab: false,
      });
    }

    this.#window.gZenWorkspaces.makeSureEmptyTabIsFirst();
    this.#window.gZenWorkspaces.updateTabsContainers();
    this.#window.gBrowser.tabContainer._invalidateCachedTabs();
  }

  #resolvePinnedEntries(entries, workspaceUuid, availableTabs, unmatchedTabs) {
    return entries
      .map(entry => {
        if (entry.type === "folder") {
          return {
            type: "folder",
            snapshot: entry,
            entries: this.#resolvePinnedEntries(
              entry.entries,
              workspaceUuid,
              availableTabs,
              unmatchedTabs
            ),
          };
        }

        const tab =
          this.#takeMatchingTab(availableTabs, unmatchedTabs, entry, {
            essential: false,
            workspaceUuid,
            requirePlacementMatch: true,
          }) ||
          this.#takeMatchingTab(availableTabs, unmatchedTabs, entry, {
            essential: false,
            workspaceUuid,
            requirePlacementMatch: false,
          }) ||
          this.#openSnapshotTab(entry);

        return {
          type: "tab",
          snapshot: entry,
          tab,
        };
      })
      .filter(Boolean);
  }

  #takeMatchingTab(availableTabs, unmatchedTabs, entry, options = {}) {
    const { essential = false, workspaceUuid = null, requirePlacementMatch } =
      options;

    const index = availableTabs.findIndex(tab => {
      if (this.#getTabUrl(tab) !== entry.url) {
        return false;
      }
      if (this.#getUserContextId(tab) !== entry.userContextId) {
        return false;
      }
      if (!requirePlacementMatch) {
        return true;
      }

      const isEssential = tab.hasAttribute("zen-essential");
      if (essential) {
        return isEssential;
      }

      return (
        !isEssential && this.#getWorkspaceIdForTab(tab) === workspaceUuid
      );
    });

    if (index === -1) {
      return null;
    }

    const [tab] = availableTabs.splice(index, 1);
    unmatchedTabs.delete(tab);
    return tab;
  }

  #openSnapshotTab(entry) {
    const tab = this.#window.gBrowser.addTrustedTab(entry.url, {
      createLazyBrowser: true,
      inBackground: true,
      skipAnimation: true,
      noInitialLabel: Boolean(entry.title),
      lazyTabTitle: entry.title || undefined,
      userContextId: entry.userContextId,
    });
    this.#window.gBrowser.pinTab(tab);
    return tab;
  }

  async #clearManagedFolders() {
    const folders = Array.from(
      this.#window.document.querySelectorAll("zen-folder")
    )
      .filter(folder => this.#isManagedFolder(folder))
      .sort((a, b) => {
        const levelDifference = toInteger(b.level, 0) - toInteger(a.level, 0);
        if (levelDifference) {
          return levelDifference;
        }

        const position = a.compareDocumentPosition(b);
        if (position & this.#window.Node.DOCUMENT_POSITION_FOLLOWING) {
          return 1;
        }
        if (position & this.#window.Node.DOCUMENT_POSITION_PRECEDING) {
          return -1;
        }
        return 0;
      });

    for (const folder of folders) {
      for (const item of [...folder.allItems].reverse()) {
        if (!this.#isManagedSidebarTab(item)) {
          continue;
        }
        this.#ungroupTab(item);
      }
    }

    for (const folder of folders) {
      if (folder.isConnected) {
        await folder.delete();
      }
    }
  }

  #ungroupTab(tab) {
    if (typeof this.#window.gBrowser.ungroupTabsUntilNoActive === "function") {
      this.#window.gBrowser.ungroupTabsUntilNoActive(tab);
      return;
    }

    if (typeof this.#window.gBrowser.ungroupTab === "function") {
      this.#window.gBrowser.ungroupTab(tab);
    }
  }

  async #placePinnedEntry(entry, context) {
    const { workspaceUuid, container, parentFolder, previousNode } = context;

    if (entry.type === "tab") {
      await this.#ensureTabMatchesSnapshot(entry.tab, {
        ...entry.snapshot,
        essential: false,
        workspaceUuid,
      });
      this.#placeTabInContext(entry.tab, {
        container,
        parentFolder,
        previousNode,
      });
      return entry.tab;
    }

    const folder = this.#createFolderFromSnapshot(
      entry.snapshot,
      workspaceUuid,
      container,
      parentFolder,
      previousNode
    );

    let childPreviousNode = null;
    for (const child of entry.entries) {
      childPreviousNode = await this.#placePinnedEntry(child, {
        workspaceUuid,
        container: null,
        parentFolder: folder,
        previousNode: childPreviousNode,
      });
    }

    folder.collapsed = entry.snapshot.collapsed;
    return folder;
  }

  #createFolderFromSnapshot(
    snapshot,
    workspaceUuid,
    container,
    parentFolder,
    previousNode
  ) {
    const folder = this.#window.gZenFolders.createFolder([], {
      id: snapshot.id,
      label: snapshot.name,
      renameFolder: false,
      collapsed: snapshot.collapsed,
      workspaceId: workspaceUuid,
      insertAfter: !parentFolder ? previousNode : undefined,
    });

    if (parentFolder) {
      this.#insertNodeAfter(
        folder,
        previousNode || this.#getFolderInsertAnchor(parentFolder)
      );
    } else if (!previousNode && container) {
      container.insertBefore(folder, this.#getContainerEndAnchor(container));
    }

    this.#window.gZenFolders.setFolderUserIcon(folder, snapshot.userIcon);
    folder.collapsed = snapshot.collapsed;
    return folder;
  }

  async #ensureTabMatchesSnapshot(tab, item) {
    if (item.essential) {
      if (!tab.pinned) {
        this.#window.gBrowser.pinTab(tab);
      }
      if (!tab.hasAttribute("zen-essential")) {
        this.#window.gZenPinnedTabManager.addToEssentials(tab);
      }
    } else {
      if (tab.hasAttribute("zen-essential")) {
        this.#window.gZenPinnedTabManager.removeEssentials(tab, false);
      } else if (!tab.pinned) {
        this.#window.gBrowser.pinTab(tab);
      }
      if (this.#getWorkspaceIdForTab(tab) !== item.workspaceUuid) {
        this.#window.gZenWorkspaces.moveTabToWorkspace(tab, item.workspaceUuid);
      }
    }

    this.#applyTabSublabel(tab, item.sublabel);
  }

  #applyTabSublabel(tab, sublabel) {
    const labelElement = tab.querySelector(".zen-tab-sublabel");
    if (!labelElement) {
      return;
    }

    if (typeof sublabel === "string" && sublabel) {
      tab.setAttribute("zen-show-sublabel", sublabel);
      this.#window.document.l10n.setArgs(labelElement, {
        tabSubtitle: sublabel,
      });
      return;
    }

    if (tab.hasAttribute("zen-show-sublabel")) {
      tab.removeAttribute("zen-show-sublabel");
    }
    this.#window.document.l10n.setArgs(labelElement, {
      tabSubtitle: "zen-default-pinned",
    });
  }

  #placeTabInContext(tab, context) {
    const { container = null, parentFolder = null, previousNode = null } =
      context;

    if (previousNode) {
      this.#moveTabAfter(tab, previousNode);
      return;
    }

    if (parentFolder) {
      this.#moveTabAfter(tab, this.#getFolderInsertAnchor(parentFolder));
      return;
    }

    if (container) {
      this.#moveTabBeforeContainerEnd(tab, container);
    }
  }

  #getFolderInsertAnchor(folder) {
    return folder.tabs[0] || folder.groupStartElement?.nextElementSibling || folder;
  }

  #moveTabBeforeContainerEnd(tab, container) {
    const endAnchor = this.#getContainerEndAnchor(container);
    this.#window.gBrowser.zenHandleTabMove(tab, () => {
      container.insertBefore(tab, endAnchor);
    });
  }

  #moveTabAfter(tab, anchor) {
    this.#window.gBrowser.zenHandleTabMove(tab, () => {
      anchor.after(tab);
    });
  }

  #insertNodeAfter(node, anchor) {
    anchor.after(node);
  }

  #getContainerEndAnchor(container) {
    if (container.classList.contains("zen-workspace-pinned-tabs-section")) {
      return container.separatorElement || container.lastChild || null;
    }
    return container.essentialsPromo || null;
  }
}
