/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  LegacyTracker,
  Store,
  SyncEngine,
} from "resource://services-sync/engines.sys.mjs";
import { CryptoWrapper } from "resource://services-sync/record.sys.mjs";
import { SCORE_INCREMENT_XLARGE } from "resource://services-sync/constants.sys.mjs";
import {
  CONTEXTUAL_IDENTITY_TOPIC_PREFIX,
  OBSERVER_TOPICS,
  RECORD_ID_PREFIX_BY_TYPE,
  RECORD_TYPES,
  RECORD_TYPE_BY_PREFIX,
  WORKSPACES_ENGINE_NAME,
  WORKSPACES_RECORD_LOG_NAME,
  WORKSPACES_RECORD_TYPE,
} from "resource:///modules/zen/ZenSyncConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSyncStore: "resource:///modules/zen/ZenSyncManager.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

/**
 * Sync record wrapper for workspace and container items stored in the
 * Workspaces engine collection.
 */
export class ZenWorkspacesRecord extends CryptoWrapper {
  _logName = WORKSPACES_RECORD_LOG_NAME;
}

ZenWorkspacesRecord.prototype.type = WORKSPACES_RECORD_TYPE;

function parseRecordId(id) {
  const sep = id.indexOf("~");
  if (sep <= 0 || sep === id.length - 1) {
    return null;
  }
  const prefix = id.slice(0, sep);
  const key = id.slice(sep + 1);
  return { type: RECORD_TYPE_BY_PREFIX[prefix] || prefix, key };
}

function createRecordId(type, id) {
  const prefix = RECORD_ID_PREFIX_BY_TYPE[type];
  if (!prefix) {
    throw new Error(`Unknown Spaces Sync record type: ${type}`);
  }
  return `${prefix}~${id}`;
}

/**
 * Strips the sync-envelope fields (`id` and `type`) from incoming record data
 * and restores the item's real identity key where needed
 *
 * @param {object} data
 */
function stripSyncFields(data) {
  const rest = { ...data };
  delete rest.id;
  delete rest.type;
  return rest;
}

function sanitizeIncomingTabData(data, syncId) {
  if (!data?.pinned || !syncId) {
    return null;
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const entryIndex = Math.max(0, (data.index || 1) - 1);
  const sourceEntry =
    data._zenPinnedInitialState?.entry || entries[entryIndex] || entries[0];
  if (!lazy.ZenSyncStore.isSyncableTabUrl(sourceEntry?.url)) {
    return null;
  }

  const entry = { url: sourceEntry.url };
  if (typeof sourceEntry.title === "string") {
    entry.title = sourceEntry.title;
  }
  let image = "";
  if (typeof data._zenPinnedInitialState?.image === "string") {
    image = data._zenPinnedInitialState.image;
  } else if (typeof data.image === "string") {
    image = data.image;
  }
  const sanitized = {
    entries: [entry],
    groupId: typeof data.groupId === "string" ? data.groupId : null,
    image,
    index: 1,
    pinned: true,
    zenDefaultUserContextId: !!data.zenDefaultUserContextId,
    zenEssential: !!data.zenEssential,
    zenHasStaticIcon: !!data.zenHasStaticIcon,
    zenSyncId: syncId,
    zenWorkspace:
      typeof data.zenWorkspace === "string" ? data.zenWorkspace : null,
    _zenPinnedInitialState: { entry, image },
  };
  if (typeof data.zenStaticLabel === "string") {
    sanitized.zenStaticLabel = data.zenStaticLabel;
  }
  if (typeof data.containerSyncId === "string") {
    sanitized.containerSyncId = data.containerSyncId;
  }
  if (Number.isSafeInteger(data.userContextId)) {
    sanitized.userContextId = data.userContextId;
  }
  if (Number.isSafeInteger(data.position) && data.position >= 0) {
    sanitized.position = data.position;
  }
  return sanitized;
}

/**
 * Sync store implementation that serializes local workspace and container
 * state into records and applies incoming remote changes.
 */
class ZenWorkspacesStore extends Store {
  constructor(name, engine) {
    super(name, engine);
  }

  async getAllIDs() {
    const ids = {};
    const sidebar = lazy.ZenSyncStore.getSidebarData();

    for (const space of sidebar.spaces || []) {
      if (space.uuid) {
        ids[createRecordId(RECORD_TYPES.SPACE, space.uuid)] = true;
      }
    }

    for (const container of lazy.ContextualIdentityService.getPublicIdentities()) {
      for (const syncId of lazy.ZenSyncStore.getContainerSyncIds(
        container.userContextId
      )) {
        ids[createRecordId(RECORD_TYPES.CONTAINER, syncId)] = true;
      }
    }
    for (const tab of sidebar.tabs || []) {
      if (tab.zenSyncId && tab.pinned) {
        ids[createRecordId(RECORD_TYPES.TAB, tab.zenSyncId)] = true;
      }
    }

    for (const folder of sidebar.folders || []) {
      if (folder.id) {
        ids[createRecordId(RECORD_TYPES.FOLDER, folder.id)] = true;
      }
    }

    const pinnedTabIds = new Set(
      (sidebar.tabs || [])
        .filter(tab => tab.pinned && tab.zenSyncId)
        .map(tab => tab.zenSyncId)
    );
    for (const splitGroup of sidebar.splitViewData || []) {
      if (
        splitGroup.groupId &&
        splitGroup.tabs?.length > 1 &&
        splitGroup.tabs.every(tabId => pinnedTabIds.has(tabId))
      ) {
        ids[createRecordId(RECORD_TYPES.SPLIT, splitGroup.groupId)] = true;
      }
    }

    return ids;
  }

  async itemExists(id) {
    const parsed = parseRecordId(id);
    if (!parsed) {
      return false;
    }
    const sidebar = lazy.ZenSyncStore.getSidebarData();

    switch (parsed.type) {
      case RECORD_TYPES.SPACE:
        return (sidebar.spaces || []).some(s => s.uuid === parsed.key);
      case RECORD_TYPES.CONTAINER:
        return lazy.ContextualIdentityService.getPublicIdentities().some(
          container =>
            container.userContextId ===
            lazy.ZenSyncStore.resolveLocalContainerId(parsed.key)
        );
      case RECORD_TYPES.TAB:
        return (sidebar.tabs || []).some(
          tab => tab.zenSyncId === parsed.key && tab.pinned
        );
      case RECORD_TYPES.FOLDER:
        return (sidebar.folders || []).some(f => String(f.id) === parsed.key);
      case RECORD_TYPES.SPLIT:
        return (sidebar.splitViewData || []).some(splitGroup => {
          if (
            splitGroup.groupId !== parsed.key ||
            splitGroup.tabs?.length < 2
          ) {
            return false;
          }
          const pinnedTabIds = new Set(
            (sidebar.tabs || [])
              .filter(tab => tab.pinned && tab.zenSyncId)
              .map(tab => tab.zenSyncId)
          );
          return splitGroup.tabs.every(tabId => pinnedTabIds.has(tabId));
        });
      default:
        return false;
    }
  }

  async createRecord(id, collection) {
    const record = new ZenWorkspacesRecord(collection, id);
    const parsed = parseRecordId(id);
    if (!parsed) {
      record.deleted = true;
      return record;
    }

    const sidebar = lazy.ZenSyncStore.getSidebarData();

    switch (parsed.type) {
      case RECORD_TYPES.SPACE: {
        const spaces = sidebar.spaces || [];
        const idx = spaces.findIndex(s => s.uuid === parsed.key);
        if (idx === -1) {
          record.deleted = true;
          return record;
        }
        const rest = { ...spaces[idx] };
        delete rest.syncStatus;
        const containerSyncId = lazy.ZenSyncStore.getContainerSyncId(
          rest.containerTabId
        );
        delete rest.containerTabId;
        record.cleartext = {
          id,
          type: RECORD_TYPES.SPACE,
          ...rest,
          position: idx,
        };
        if (containerSyncId) {
          record.cleartext.containerSyncId = containerSyncId;
        }
        break;
      }

      case RECORD_TYPES.CONTAINER: {
        const localId = lazy.ZenSyncStore.resolveLocalContainerId(parsed.key);
        const container =
          lazy.ContextualIdentityService.getPublicIdentities().find(
            candidate => candidate.userContextId === localId
          );
        if (!container) {
          record.deleted = true;
          return record;
        }
        record.cleartext = {
          id,
          type: RECORD_TYPES.CONTAINER,
          syncId: parsed.key,
          name: lazy.ContextualIdentityService.getUserContextLabel(
            container.userContextId
          ),
          l10nId: container.l10nId || null,
          icon: container.icon,
          color: container.color,
          semanticOrdinal: lazy.ZenSyncStore.getContainerSemanticOrdinal(
            container.userContextId
          ),
        };
        break;
      }
      case RECORD_TYPES.TAB: {
        const tabs = sidebar.tabs || [];
        const idx = tabs.findIndex(t => t.zenSyncId === parsed.key);
        const tab = idx === -1 ? null : tabs[idx];
        if (!tab) {
          record.deleted = true;
          return record;
        }
        const syncableTabData = lazy.ZenSyncStore.createSyncableTabData(tab, {
          position: idx,
        });
        if (!syncableTabData?.zenSyncId) {
          record.deleted = true;
          return record;
        }
        record.cleartext = { id, type: RECORD_TYPES.TAB, ...syncableTabData };
        break;
      }
      case RECORD_TYPES.FOLDER: {
        const folders = sidebar.folders || [];
        const folderIndex = folders.findIndex(
          folder => String(folder.id) === parsed.key
        );
        if (folderIndex === -1) {
          record.deleted = true;
          return record;
        }
        const folder = folders[folderIndex];
        const { id: folderId, ...rest } = folder;
        delete rest.syncStatus;
        record.cleartext = {
          id,
          type: RECORD_TYPES.FOLDER,
          folderId,
          position: folderIndex,
          ...rest,
        };
        break;
      }
      case RECORD_TYPES.SPLIT: {
        const splitGroup = (sidebar.splitViewData || []).find(
          group => group.groupId === parsed.key
        );
        const pinnedTabIds = new Set(
          (sidebar.tabs || [])
            .filter(tab => tab.pinned && tab.zenSyncId)
            .map(tab => tab.zenSyncId)
        );
        if (
          !splitGroup ||
          splitGroup.tabs?.length < 2 ||
          !splitGroup.tabs.every(tabId => pinnedTabIds.has(tabId))
        ) {
          record.deleted = true;
          return record;
        }
        record.cleartext = {
          id,
          type: RECORD_TYPES.SPLIT,
          groupId: splitGroup.groupId,
          gridType: splitGroup.gridType,
          layoutTree: splitGroup.layoutTree,
          tabs: Array.isArray(splitGroup.tabs) ? [...splitGroup.tabs] : [],
        };
        break;
      }
      default:
        record.deleted = true;
    }

    return record;
  }

  async applyIncomingBatch(records, _countTelemetry) {
    const pulled = {
      spaces: [],
      tabs: [],
      folders: [],
      containers: [],
      splits: [],
    };
    const removals = {
      spaces: [],
      tabs: [],
      folders: [],
      containers: [],
      splits: [],
    };
    for (const record of records) {
      if (record.deleted) {
        this._collectRemoval(record.id, removals);
        continue;
      }
      const data = record.cleartext;
      if (!data?.type) {
        continue;
      }
      const parsedRecordId = parseRecordId(record.id);
      const clean = stripSyncFields(data);
      switch (data.type) {
        case RECORD_TYPES.SPACE:
          pulled.spaces.push(clean);
          break;
        case RECORD_TYPES.CONTAINER:
          clean.syncId =
            parsedRecordId?.type === RECORD_TYPES.CONTAINER
              ? parsedRecordId.key
              : clean.syncId;
          if (!clean.syncId) {
            break;
          }
          pulled.containers.push(clean);
          break;
        case RECORD_TYPES.TAB: {
          const recordTabId =
            parsedRecordId?.type === RECORD_TYPES.TAB
              ? parsedRecordId.key
              : null;
          const syncId =
            typeof recordTabId === "string" && recordTabId
              ? recordTabId
              : clean.zenSyncId;
          const sanitized = sanitizeIncomingTabData(clean, syncId);
          if (!sanitized) {
            break;
          }
          pulled.tabs.push(sanitized);
          break;
        }
        case RECORD_TYPES.FOLDER:
          clean.id =
            clean.folderId ||
            (parsedRecordId?.type === RECORD_TYPES.FOLDER
              ? parsedRecordId.key
              : null);
          if (!clean.id) {
            break;
          }
          delete clean.folderId;
          pulled.folders.push(clean);
          break;
        case RECORD_TYPES.SPLIT:
          clean.groupId =
            clean.groupId ||
            (parsedRecordId?.type === RECORD_TYPES.SPLIT
              ? parsedRecordId.key
              : null);
          if (!clean.groupId) {
            break;
          }
          pulled.splits.push(clean);
          break;
      }
    }

    // Suppress change tracking while applying incoming data to prevent
    // feedback loops where applied items get re-uploaded immediately.
    let postApplyItems = [];
    this.engine._tracker.ignoreAll = true;
    try {
      await lazy.ZenSyncStore.applyIncomingBatch(pulled, removals);
      postApplyItems = lazy.ZenSyncStore.takePostApplyItems();
    } finally {
      this.engine._tracker.ignoreAll = false;
    }
    await this._trackPostApplyItems(postApplyItems);
    return [];
  }

  async _trackPostApplyItems(items) {
    let trackedAny = false;
    for (const item of items) {
      const recordId = createRecordId(item.type, item.id);
      trackedAny =
        (await this.engine._tracker.addChangedID(recordId)) || trackedAny;
    }
    if (trackedAny) {
      this.engine._tracker.score += SCORE_INCREMENT_XLARGE;
    }
  }

  _collectRemoval(id, removals) {
    const parsed = parseRecordId(id);
    if (!parsed) {
      return;
    }
    switch (parsed.type) {
      case RECORD_TYPES.SPACE:
        removals.spaces.push({ uuid: parsed.key });
        break;
      case RECORD_TYPES.CONTAINER: {
        removals.containers.push({ syncId: parsed.key });
        break;
      }
      case RECORD_TYPES.TAB:
        removals.tabs.push({ zenSyncId: parsed.key });
        break;
      case RECORD_TYPES.FOLDER:
        removals.folders.push({ id: parsed.key });
        break;
      case RECORD_TYPES.SPLIT:
        removals.splits.push({ groupId: parsed.key });
        break;
    }
  }

  async create(record) {
    await this._applySingle(record);
  }

  async update(record) {
    await this._applySingle(record);
  }

  async _applySingle(record) {
    let postApplyItems = [];
    this.engine._tracker.ignoreAll = true;
    try {
      if (record.deleted) {
        const removals = {
          spaces: [],
          tabs: [],
          folders: [],
          containers: [],
          splits: [],
        };
        this._collectRemoval(record.id, removals);
        await lazy.ZenSyncStore.applyIncomingBatch(
          { spaces: [], tabs: [], folders: [], containers: [], splits: [] },
          removals
        );
        postApplyItems = lazy.ZenSyncStore.takePostApplyItems();
        return;
      }
      const data = record.cleartext;
      if (!data?.type) {
        return;
      }
      const parsedRecordId = parseRecordId(record.id);
      const clean = stripSyncFields(data);
      const pulled = {
        spaces: [],
        tabs: [],
        folders: [],
        containers: [],
        splits: [],
      };
      switch (data.type) {
        case RECORD_TYPES.SPACE:
          pulled.spaces.push(clean);
          break;
        case RECORD_TYPES.CONTAINER:
          clean.syncId =
            parsedRecordId?.type === RECORD_TYPES.CONTAINER
              ? parsedRecordId.key
              : clean.syncId;
          if (!clean.syncId) {
            break;
          }
          pulled.containers.push(clean);
          break;
        case RECORD_TYPES.TAB: {
          const recordTabId =
            parsedRecordId?.type === RECORD_TYPES.TAB
              ? parsedRecordId.key
              : null;
          const syncId =
            typeof recordTabId === "string" && recordTabId
              ? recordTabId
              : clean.zenSyncId;
          const sanitized = sanitizeIncomingTabData(clean, syncId);
          if (!sanitized) {
            break;
          }
          pulled.tabs.push(sanitized);
          break;
        }
        case RECORD_TYPES.FOLDER:
          clean.id =
            clean.folderId ||
            (parsedRecordId?.type === RECORD_TYPES.FOLDER
              ? parsedRecordId.key
              : null);
          if (!clean.id) {
            break;
          }
          delete clean.folderId;
          pulled.folders.push(clean);
          break;
        case RECORD_TYPES.SPLIT:
          clean.groupId =
            clean.groupId ||
            (parsedRecordId?.type === RECORD_TYPES.SPLIT
              ? parsedRecordId.key
              : null);
          if (!clean.groupId) {
            break;
          }
          pulled.splits.push(clean);
          break;
      }
      await lazy.ZenSyncStore.applyIncomingBatch(pulled, {
        spaces: [],
        tabs: [],
        folders: [],
        containers: [],
        splits: [],
      });
      postApplyItems = lazy.ZenSyncStore.takePostApplyItems();
    } finally {
      this.engine._tracker.ignoreAll = false;
      await this._trackPostApplyItems(postApplyItems);
    }
  }

  async remove() {
    // No-op: never delete user data on wipe
  }

  async wipe() {
    // No-op: never delete user data on wipe
  }

  changeItemID() {
    // No-op
  }
}

/**
 * Sync tracker that watches workspace and contextual identity observers and
 * marks the corresponding record IDs as changed.
 */
class ZenWorkspacesTracker extends LegacyTracker {
  onStart() {
    Services.obs.addObserver(this, OBSERVER_TOPICS.ZEN_WORKSPACE_ITEM_CHANGED);
    Services.obs.addObserver(this, OBSERVER_TOPICS.CONTEXTUAL_IDENTITY_CREATED);
    Services.obs.addObserver(this, OBSERVER_TOPICS.CONTEXTUAL_IDENTITY_UPDATED);
    Services.obs.addObserver(this, OBSERVER_TOPICS.CONTEXTUAL_IDENTITY_DELETED);
  }

  onStop() {
    Services.obs.removeObserver(
      this,
      OBSERVER_TOPICS.ZEN_WORKSPACE_ITEM_CHANGED
    );
    Services.obs.removeObserver(
      this,
      OBSERVER_TOPICS.CONTEXTUAL_IDENTITY_CREATED
    );
    Services.obs.removeObserver(
      this,
      OBSERVER_TOPICS.CONTEXTUAL_IDENTITY_UPDATED
    );
    Services.obs.removeObserver(
      this,
      OBSERVER_TOPICS.CONTEXTUAL_IDENTITY_DELETED
    );
  }

  observe(subject, topic, _data) {
    const item = subject?.wrappedJSObject;
    this.asyncObserver.enqueueCall(() =>
      this.#handleObservedChange(item, topic)
    );
  }

  async #handleObservedChange(item, topic) {
    if (this.ignoreAll) {
      return;
    }
    if (topic === OBSERVER_TOPICS.ZEN_WORKSPACE_ITEM_CHANGED) {
      const type = item?.type;
      const id = item?.id;
      if (type && id) {
        await this.#trackChange({ type, id });
      }
    } else if (topic.startsWith(CONTEXTUAL_IDENTITY_TOPIC_PREFIX)) {
      const id = item?.userContextId;
      for (const syncId of lazy.ZenSyncStore.getContainerSyncIds(id)) {
        await this.#trackChange({
          type: RECORD_TYPES.CONTAINER,
          id: syncId,
        });
      }
    }
  }

  async #trackChange(data) {
    if (data.type && data.id) {
      const id = createRecordId(data.type, data.id);
      if (await this.addChangedID(id)) {
        this.score += SCORE_INCREMENT_XLARGE;
      }
    }
  }
}

/**
 * Sync engine entrypoint that wires the Workspaces record, store, and tracker
 * implementations into Firefox Sync.
 */
export class ZenWorkspacesEngine extends SyncEngine {
  static get name() {
    return WORKSPACES_ENGINE_NAME;
  }

  constructor(service) {
    super(WORKSPACES_ENGINE_NAME, service);
  }

  get _storeObj() {
    return ZenWorkspacesStore;
  }

  get _trackerObj() {
    return ZenWorkspacesTracker;
  }

  get _recordObj() {
    return ZenWorkspacesRecord;
  }

  get version() {
    return 4;
  }

  get syncPriority() {
    return 8;
  }

  get allowSkippedRecord() {
    return false;
  }
}
