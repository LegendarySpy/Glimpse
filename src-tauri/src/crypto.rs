use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac_array;
use rand::RngCore;
use sha2::Sha256;
use std::process::Command;
use std::sync::OnceLock;

const PBKDF2_ITERATIONS: u32 = 100_000;
const NONCE_SIZE: usize = 12;
const SALT: &[u8] = b"glimpse_api_key_v1";

static CACHED_KEY: OnceLock<(String, [u8; 32])> = OnceLock::new();

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
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            if let Some(uuid) = line.split('"').nth(3) {
                return Some(uuid.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub fn get_hardware_uuid() -> Option<String> {
    let output = Command::new("wmic")
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

#[cfg(target_os = "linux")]
pub fn get_hardware_uuid() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id")
        .map(|s| s.trim().to_string())
        .ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn get_hardware_uuid() -> Option<String> {
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
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
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

    let nonce = Nonce::from_slice(&combined[..NONCE_SIZE]);
    let ciphertext = &combined[NONCE_SIZE..];

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let uuid = "test-uuid-12345";
        let plaintext = "sk-my-secret-api-key";

        let encrypted = encrypt(plaintext, uuid).expect("encryption failed");
        assert!(!encrypted.is_empty());
        assert_ne!(encrypted, plaintext);

        let decrypted = decrypt(&encrypted, uuid).expect("decryption failed");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_wrong_uuid_fails() {
        let uuid1 = "uuid-one";
        let uuid2 = "uuid-two";
        let plaintext = "secret";

        let encrypted = encrypt(plaintext, uuid1).expect("encryption failed");
        let result = decrypt(&encrypted, uuid2);

        assert!(result.is_err());
    }

    #[test]
    fn test_empty_string() {
        let uuid = "test-uuid";
        let encrypted = encrypt("", uuid).expect("encryption failed");
        assert!(encrypted.is_empty());

        let decrypted = decrypt("", uuid).expect("decryption failed");
        assert!(decrypted.is_empty());
    }

    #[test]
    fn test_looks_encrypted() {
        assert!(!looks_encrypted("abc"));

        assert!(!looks_encrypted("sk-abc123"));
        assert!(!looks_encrypted(
            "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz"
        ));
        assert!(!looks_encrypted("pk-test-abc123xyz"));
        assert!(!looks_encrypted("api-key-123456789"));
        assert!(!looks_encrypted("token-abcdef123456"));
        assert!(!looks_encrypted(
            "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        ));

        assert!(!looks_encrypted("YWJj"));
        assert!(!looks_encrypted("YWJjZGVmZ2hpamts"));

        let uuid = "test-uuid";
        let encrypted = encrypt("test-api-key", uuid).expect("encryption failed");
        assert!(looks_encrypted(&encrypted));
    }

    #[test]
    fn test_migration_scenario() {
        let uuid = "hardware-uuid-12345";
        let plaintext_key = "sk-1234567890abcdef";

        assert!(!looks_encrypted(plaintext_key));

        let encrypted = encrypt(plaintext_key, uuid).expect("encrypt failed");

        assert!(looks_encrypted(&encrypted));

        let decrypted = decrypt(&encrypted, uuid).expect("decrypt failed");
        assert_eq!(decrypted, plaintext_key);
    }

    #[test]
    fn test_hardware_uuid_available() {
        let uuid = get_hardware_uuid();
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        assert!(
            uuid.is_some(),
            "Hardware UUID should be available on this platform"
        );
    }
}
