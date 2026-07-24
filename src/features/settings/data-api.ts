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

export function exportDataset(
  destination: string,
  includeTimestamps: boolean,
): Promise<DatasetSummary> {
  return invoke<DatasetSummary>("export_dataset", {
    destination,
    includeTimestamps,
  });
}

export function deleteAllData(): Promise<void> {
  return invoke<void>("delete_all_data");
}
