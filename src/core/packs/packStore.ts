import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ImportedPack } from "./eccImport";
import { importPackBackup, type PackBackupFile, type PackBackupImportMode } from "./packBackup";
import { normalizePackCatalog } from "./packMigration";
import {
  createEmptyPackCatalog,
  installImportedPack,
  removePack as removePackFromCatalog,
  selectEnabledPacks,
  selectEnabledBrainSkills,
  selectEnabledCommands,
  selectEnabledRules,
  selectEnabledSkills,
  setPackEnabled as setCatalogPackEnabled,
  setPackScope as setCatalogPackScope,
  updatePackItem as updateCatalogPackItem,
  type EditablePackItemKind,
  type EditablePackItemPatch,
  type InstalledPackMetadata,
  type InstalledPack,
  type PackCatalogCommand,
  type PackCatalogRule,
  type PackCatalogSkill,
  type PackCatalogStateData,
  type PackScope,
} from "./packCatalog";
import type { BrainSkill } from "../brainStore";

export interface PackStoreState extends PackCatalogStateData {
  installPack: (pack: ImportedPack, metadata: InstalledPackMetadata) => void;
  removePack: (packId: string) => void;
  setPackEnabled: (packId: string, enabled: boolean) => void;
  setPackScope: (packId: string, scope: PackScope, projectIds?: string[]) => void;
  updatePackItem: (packId: string, kind: EditablePackItemKind, itemId: string, patch: EditablePackItemPatch) => void;
  importBackup: (backup: PackBackupFile, mode?: PackBackupImportMode) => void;
  clearPacks: () => void;
  getEnabledPacks: (projectId?: string | null) => InstalledPack[];
  getEnabledSkills: (projectId?: string | null) => PackCatalogSkill[];
  getEnabledBrainSkills: (projectId?: string | null) => BrainSkill[];
  getEnabledCommands: (projectId?: string | null) => PackCatalogCommand[];
  getEnabledRules: (projectId?: string | null) => PackCatalogRule[];
}

function stateData(state: PackCatalogStateData): PackCatalogStateData {
  return normalizePackCatalog(state);
}

export const usePackStore = create<PackStoreState>()(
  persist(
    (set, get) => ({
      ...createEmptyPackCatalog(),

      installPack: (pack, metadata) =>
        set((state) => installImportedPack(stateData(state), pack, metadata)),

      removePack: (packId) =>
        set((state) => removePackFromCatalog(stateData(state), packId)),

      setPackEnabled: (packId, enabled) =>
        set((state) => setCatalogPackEnabled(stateData(state), packId, enabled)),

      setPackScope: (packId, scope, projectIds = []) =>
        set((state) => setCatalogPackScope(stateData(state), packId, scope, projectIds)),

      updatePackItem: (packId, kind, itemId, patch) =>
        set((state) => updateCatalogPackItem(stateData(state), packId, kind, itemId, patch)),

      importBackup: (backup, mode = "merge") =>
        set((state) => importPackBackup(stateData(state), backup, mode)),

      clearPacks: () => set(createEmptyPackCatalog()),

      getEnabledPacks: (projectId) => selectEnabledPacks(stateData(get()), projectId),
      getEnabledSkills: (projectId) => selectEnabledSkills(stateData(get()), projectId),
      getEnabledBrainSkills: (projectId) => selectEnabledBrainSkills(stateData(get()), projectId),
      getEnabledCommands: (projectId) => selectEnabledCommands(stateData(get()), projectId),
      getEnabledRules: (projectId) => selectEnabledRules(stateData(get()), projectId),
    }),
    {
      name: "rush-pack-catalog",
      version: 1,
      migrate: (persisted) => normalizePackCatalog(persisted),
      partialize: (state) => ({
        schemaVersion: state.schemaVersion,
        packs: state.packs,
      }),
    },
  ),
);
