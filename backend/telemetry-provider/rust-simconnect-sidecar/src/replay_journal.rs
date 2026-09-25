//! Publish a complete, flushed recovery record before the first simulator write.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Journal {
    pub version: u32,
    pub session: String,
    pub title: String,
    pub freeze: [bool; 3],
}

pub(crate) fn save(journal: &Journal) -> Result<(), String> {
    let data = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    publish(&crate::replay_exclusion::journal_path()?, |file| {
        file.write_all(&data)
    })
    .map_err(|e| e.to_string())
}

fn publish(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pending = path.with_file_name(format!("recovery-{}-{nonce}.pending", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)?;
    let result = (|| {
        write(&mut file)?;
        file.sync_all()?;
        // A hard link publishes complete bytes atomically and refuses to
        // replace an existing recovery record. Partial writes never occupy
        // recovery.json and therefore cannot strand ordinary live bridges.
        fs::hard_link(&pending, path)
    })();
    drop(file);
    let _ = fs::remove_file(&pending);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_publication_does_not_block_live_mode_or_replace_existing_recovery() {
        let root =
            std::env::temp_dir().join(format!("ff-replay-journal-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("recovery.json");
        let error = publish(&path, |file| {
            file.write_all(b"{partial")?;
            Err(io::Error::other(
                "injected disk failure before simulator mutation",
            ))
        });
        assert!(error.is_err());
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        publish(&path, |file| file.write_all(b"{\"complete\":true}")).unwrap();
        assert!(publish(&path, |file| file.write_all(b"replacement")).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{\"complete\":true}");
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
