use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use pbkdf2::pbkdf2_hmac_array;
use rand::Rng;
use sha2::Sha256;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::OnceLock;

const PBKDF2_ITERATIONS: u32 = 100_000;
const NONCE_SIZE: usize = 12;
const SALT: &[u8] = b"glimpse_api_key_v1";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static CACHED_KEY: OnceLock<(String, [u8; 32])> = OnceLock::new();
#[cfg(target_os = "windows")]
static WINDOWS_CACHED_HARDWARE_UUID: OnceLock<Option<String>> = OnceLock::new();

fn get_or_derive_key(hardware_uuid: &str) -> [u8; 32] {
    if let Some((cached_uuid, cached_key)) = CACHED_KEY.get() {
        if cached_uuid == hardware_uuid {
            return *cached_key;
        }
        return pbkdf2_hmac_array::<Sha256, 32>(hardware_uuid.as_bytes(), SALT, PBKDF2_ITERATIONS);
    }

    let key = pbkdf2_hmac_array::<Sha256, 32>(hardware_uuid.as_bytes(), SALT, PBKDF2_ITERATIONS);
    let _ = CACHED_KEY.set((hardware_uuid.to_string(), key));
    key
}

#[cfg(target_os = "macos")]
pub fn get_hardware_uuid() -> Option<String> {
    let output = Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID")
            && let Some(uuid) = line.split('"').nth(3)
        {
            return Some(uuid.to_string());
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub fn get_hardware_uuid() -> Option<String> {
    WINDOWS_CACHED_HARDWARE_UUID
        .get_or_init(query_windows_hardware_uuid)
        .clone()
}

#[cfg(target_os = "windows")]
fn query_windows_hardware_uuid() -> Option<String> {
    let output = Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
        ])
        .output()
        .ok();

    if let Some(output) = output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(uuid) = stdout.lines().map(str::trim).find(|line| !line.is_empty()) {
                return Some(uuid.to_string());
            }
        }
    }

    let output = Command::new("wmic")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["csproduct", "get", "uuid"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines().skip(1) {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

pub fn encrypt(plaintext: &str, hardware_uuid: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }

    let key = get_or_derive_key(hardware_uuid);

    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {}", e))?;

    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::try_from(nonce_bytes.as_slice())
        .map_err(|_| "Failed to create nonce".to_string())?;

    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let mut combined = nonce_bytes.to_vec();
    combined.extend(ciphertext);

    Ok(BASE64.encode(&combined))
}

pub fn decrypt(encrypted: &str, hardware_uuid: &str) -> Result<String, String> {
    if encrypted.is_empty() {
        return Ok(String::new());
    }

    let key = get_or_derive_key(hardware_uuid);

    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Failed to create cipher: {}", e))?;

    let combined = BASE64
        .decode(encrypted)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    if combined.len() < NONCE_SIZE {
        return Err("Ciphertext too short".to_string());
    }

    let nonce = Nonce::try_from(&combined[..NONCE_SIZE])
        .map_err(|_| "Invalid nonce in ciphertext".to_string())?;
    let ciphertext = &combined[NONCE_SIZE..];

    let plaintext = cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|_| "Decryption failed - different hardware or corrupted data".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8 in decrypted data: {}", e))
}

pub fn looks_encrypted(value: &str) -> bool {
    if value.is_empty() || value.len() < 40 {
        return false;
    }

    let plaintext_prefixes = ["sk-", "pk-", "api-", "key-", "token-", "bearer-"];
    let lower = value.to_lowercase();
    if plaintext_prefixes.iter().any(|p| lower.starts_with(p)) {
        return false;
    }

    const MIN_ENCRYPTED_BYTES: usize = NONCE_SIZE + 16 + 1;

    BASE64
        .decode(value)
        .map(|d| d.len() >= MIN_ENCRYPTED_BYTES)
        .unwrap_or(false)
}
