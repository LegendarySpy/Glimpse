import { invoke } from "@tauri-apps/api/core";

export type DatasetPreview = {
  pairs: number;
};

export type DatasetSummary = {
  pairs: number;
  skipped: number;
  path: string;
};

export function getDatasetPreview(): Promise<DatasetPreview> {
  return invoke<DatasetPreview>("dataset_preview");
}

export type DatasetExportOptions = {
  includeTimestamps: boolean;
  verbatimText: boolean;
  skipShortClips: boolean;
};

export function exportDataset(
  destination: string,
  options: DatasetExportOptions,
): Promise<DatasetSummary> {
  return invoke<DatasetSummary>("export_dataset", {
    destination,
    options,
  });
}

export function deleteAllData(): Promise<void> {
  return invoke<void>("delete_all_data");
}
