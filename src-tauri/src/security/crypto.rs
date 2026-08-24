//! 静态密钥加密：AES-256-GCM + 主密钥。
//!
//! 主密钥优先存系统凭据库（Windows 凭据管理器），失败时降级为进程内随机密钥
//! （重启后失效，仅保证测试/无凭据环境可用）。密文格式 `lgwe:v1:<nonce_b64>:<ct_b64>`。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;

pub const ENC_PREFIX: &str = "lgwe:v1:";

pub struct Cipher {
    key: [u8; 32],
    cipher: Aes256Gcm,
}

impl Cipher {
    pub fn random() -> Self {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        Self::from_bytes(key)
    }

    pub fn from_bytes(key: [u8; 32]) -> Self {
        let cipher = Aes256Gcm::new_from_slice(&key).expect("AES-256 key must be 32 bytes");
        Cipher { key, cipher }
    }

    /// 从系统凭据库加载主密钥；不存在则生成并保存。
    /// 凭据库不可用时降级为进程内随机密钥（日志警告）。
    pub fn keyring_load_or_create() -> Self {
        const SERVICE: &str = "llm-gateway";
        const USER: &str = "master-key";
        let entry = match keyring::Entry::new(SERVICE, USER) {
            Ok(e) => e,
            Err(err) => {
                log::warn!("keyring init failed, falling back to in-memory key: {err}");
                return Self::random();
            }
        };
        if let Ok(pw) = entry.get_password() {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&pw) {
                if bytes.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&bytes);
                    return Self::from_bytes(key);
                }
            }
        }
        let generated = Self::random();
        let b64 = base64::engine::general_purpose::STANDARD.encode(generated.key);
        if let Err(err) = entry.set_password(&b64) {
            log::warn!("keyring save failed, key will not persist across restarts: {err}");
        }
        generated
    }

    pub fn encrypt(&self, plain: &str) -> String {
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = self
            .cipher
            .encrypt(nonce, plain.as_bytes())
            .unwrap_or_default();
        let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(nonce_bytes);
        let ct_b64 = base64::engine::general_purpose::STANDARD.encode(ct);
        format!("{ENC_PREFIX}{nonce_b64}:{ct_b64}")
    }

    pub fn decrypt(&self, blob: &str) -> Result<String, String> {
        let rest = blob
            .strip_prefix(ENC_PREFIX)
            .ok_or_else(|| "not an encrypted blob".to_string())?;
        let (nonce_b64, ct_b64) = rest
            .split_once(':')
            .ok_or_else(|| "malformed encrypted blob".to_string())?;
        let nonce_bytes = base64::engine::general_purpose::STANDARD
            .decode(nonce_b64)
            .map_err(|e| e.to_string())?;
        let ct = base64::engine::general_purpose::STANDARD
            .decode(ct_b64)
            .map_err(|e| e.to_string())?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let plain = self
            .cipher
            .decrypt(nonce, ct.as_ref())
            .map_err(|e| format!("decrypt failed: {e}"))?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    }

    pub fn is_encrypted(blob: &str) -> bool {
        blob.starts_with(ENC_PREFIX)
    }
}

/// SHA-256 摘要的 base64（用于 api_keys.key_hash 认证查找与唯一约束）。
pub fn sha256_b64(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let c = Cipher::random();
        let blob = c.encrypt("sk-lgw-secret");
        assert!(Cipher::is_encrypted(&blob));
        assert_eq!(c.decrypt(&blob).unwrap(), "sk-lgw-secret");
        // 随机 nonce → 同明文两次加密结果不同
        assert_ne!(c.encrypt("x"), c.encrypt("x"));
    }

    #[test]
    fn decrypt_plaintext_fails_and_is_detectable() {
        let c = Cipher::random();
        assert!(!Cipher::is_encrypted("plain"));
        assert!(c.decrypt("plain").is_err());
    }

    #[test]
    fn sha256_b64_stable() {
        let a = sha256_b64("sk-lgw-abc");
        let b = sha256_b64("sk-lgw-abc");
        assert_eq!(a, b);
        assert_ne!(a, sha256_b64("sk-lgw-abd"));
    }
}
