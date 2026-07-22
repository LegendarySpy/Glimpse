export type StorageBreakdown = {
  recordings_bytes: number;
  library_bytes: number;
  databases_bytes: number;
  models_bytes: number;
  total_bytes: number;
};

export type AppInfo = {
  version: string;
  data_dir_size_bytes: number;
  data_dir_path: string;
  storage_breakdown: StorageBreakdown;
  store_build: boolean;
};
