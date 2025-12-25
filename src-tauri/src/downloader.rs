use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::Serialize;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy)]
pub struct ModelFileDescriptor {
    pub url: &'static str,
    pub name: &'static str,
}

#[derive(Serialize, Clone)]
struct DownloadProgressPayload {
    model: String,
    file: String,
    downloaded: u64,
    total: u64,
    percent: f64,
}

#[derive(Serialize, Clone)]
struct DownloadCompletePayload {
    model: String,
}

#[derive(Serialize, Clone)]
struct DownloadErrorPayload {
    model: String,
    error: String,
}

pub async fn download_file<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    url: &str,
    file_name: &str,
    model_name: &str,
    target_dir: &Path,
    cancel_token: &CancellationToken,
) -> Result<()> {
    let target_path = target_dir.join(file_name);
    let mut res = client
        .get(url)
        .send()
        .await
        .context("Failed to make request")?;
    let total_size = res.content_length().unwrap_or(0);

    if !res.status().is_success() {
        return Err(anyhow!("Download failed with status: {}", res.status()));
    }

    let mut file = File::create(&target_path).context("Failed to create file")?;
    let mut downloaded: u64 = 0;

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                drop(file);
                let _ = std::fs::remove_file(&target_path);
                return Err(anyhow!("Download cancelled"));
            }
            chunk_result = res.chunk() => {
                match chunk_result.context("Failed to read chunk")? {
                    Some(chunk) => {
                        file.write_all(&chunk).context("Failed to write to file")?;
                        downloaded += chunk.len() as u64;

                        let percent = if total_size > 0 {
                            (downloaded as f64 / total_size as f64) * 100.0
                        } else {
                            0.0
                        };

                        app.emit(
                            "download:progress",
                            DownloadProgressPayload {
                                model: model_name.to_string(),
                                file: file_name.to_string(),
                                downloaded,
                                total: total_size,
                                percent,
                            },
                        )?;
                    }
                    None => break,
                }
            }
        }
    }

    Ok(())
}

pub async fn download_model_files<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
    model: &str,
    files: &[ModelFileDescriptor],
    target_dir: &Path,
    cancel_token: &CancellationToken,
) -> Result<()> {
    if !target_dir.exists() {
        std::fs::create_dir_all(target_dir).context("Failed to create model directory")?;
    }

    for descriptor in files {
        if cancel_token.is_cancelled() {
            return Err(anyhow!("Download cancelled"));
        }
        
        if let Err(err) = download_file(
            app,
            client,
            descriptor.url,
            descriptor.name,
            model,
            target_dir,
            cancel_token,
        )
        .await
        {
            let _ = app.emit(
                "download:error",
                DownloadErrorPayload {
                    model: model.to_string(),
                    error: err.to_string(),
                },
            );
            return Err(err);
        }
    }

    let _ = app.emit(
        "download:complete",
        DownloadCompletePayload {
            model: model.to_string(),
        },
    );
    Ok(())
}
