import { invoke } from "@tauri-apps/api/core";
import { importEccPack, type EccImportOptions, type ImportedPack, type PackSourceFile } from "./eccImport";
import { usePackStore } from "./packStore";
import type { InstalledPackMetadata } from "./packCatalog";

export interface PackFolderScan {
  root: string;
  files: PackSourceFile[];
  skipped_count: number;
  warnings: string[];
}

export interface PackFolderImportResult {
  scanned: PackFolderScan;
  imported: ImportedPack;
  packId: string;
}

export interface PackFolderPreviewResult {
  scanned: PackFolderScan;
  imported: ImportedPack;
  suggestedName: string;
  suggestedSourcePath: string;
}

export function packNameFromPath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return clean.split("/").filter(Boolean).pop() || "Imported Pack";
}

export function importScannedPack(
  scanned: PackFolderScan,
  options: EccImportOptions = {},
  metadata: Partial<InstalledPackMetadata> = {},
): PackFolderImportResult {
  const imported = importEccPack(scanned.files, options);
  const name = metadata.name?.trim() || packNameFromPath(scanned.root);
  const sourcePath = metadata.sourcePath?.trim() || scanned.root;
  const id = metadata.id;
  usePackStore.getState().installPack(imported, {
    ...metadata,
    id,
    name,
    sourcePath,
  });
  const packId = usePackStore.getState().packs[0]?.id ?? "";
  return { scanned, imported, packId };
}

export async function scanPackFolder(path: string): Promise<PackFolderScan> {
  return invoke<PackFolderScan>("scan_pack_folder", { path });
}

export async function previewPackFolder(
  path: string,
  options: EccImportOptions = {},
  metadata: Partial<InstalledPackMetadata> = {},
): Promise<PackFolderPreviewResult> {
  const scanned = await scanPackFolder(path);
  const imported = importEccPack(scanned.files, options);
  return {
    scanned,
    imported,
    suggestedName: metadata.name?.trim() || packNameFromPath(scanned.root),
    suggestedSourcePath: metadata.sourcePath?.trim() || scanned.root,
  };
}

export async function importPackFolder(
  path: string,
  options: EccImportOptions = {},
  metadata: Partial<InstalledPackMetadata> = {},
): Promise<PackFolderImportResult> {
  const scanned = await scanPackFolder(path);
  return importScannedPack(scanned, options, metadata);
}
