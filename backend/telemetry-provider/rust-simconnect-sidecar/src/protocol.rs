//! Newline-delimited JSON protocol used between Node and the Rust sidecar.
//!
//! Node writes commands to stdin and reads JSON messages from stdout. A
//! background reader thread performs bounded line parsing and feeds a bounded
//! synchronous channel, allowing the SimConnect dispatch loop to remain
//! responsive without permitting unbounded input buffering. This file defines
//! wire shapes and transport limits; command semantics live in `main.rs`.

use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::Duration;

pub(crate) const MAX_STDIN_LINE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_PENDING_STDIN_COMMANDS: usize = 64;
pub(crate) const MAX_COMMANDS_PER_TICK: usize = 64;

// A subscription accepts the current expression form and the legacy `simvar`
// field. `reference` provides one compatibility view to the rest of the crate.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Subscription {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) expression: String,
    #[serde(default)]
    pub(crate) simvar: Option<String>,
    #[serde(default)]
    pub(crate) unit: Option<String>,
    #[serde(default, rename = "dataType")]
    pub(crate) data_type: Option<String>,
    #[serde(default)]
    pub(crate) isolated: bool,
}

impl Subscription {
    pub(crate) fn reference(&self) -> &str {
        let expression = self.expression.trim();
        if !expression.is_empty() {
            return expression;
        }
        self.simvar.as_deref().unwrap_or_default().trim()
    }
}

// One broad command shape keeps serde parsing at the process boundary. Each
// command handler validates the subset of optional fields it actually uses.
#[derive(Debug, Deserialize)]
pub(crate) struct Command {
    #[serde(rename = "type")]
    pub(crate) command_type: String,
    #[serde(default, rename = "requestId")]
    pub(crate) request_id: Option<u64>,
    #[serde(default, rename = "subscriptionGeneration")]
    pub(crate) subscription_generation: Option<u64>,
    #[serde(default)]
    pub(crate) subscriptions: Vec<Subscription>,
    #[serde(default)]
    pub(crate) aircraft: Option<String>,
    #[serde(default)]
    pub(crate) icao: Option<String>,
    #[serde(default)]
    pub(crate) region: Option<String>,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) code: Option<String>,
    #[serde(default)]
    pub(crate) unit: Option<String>,
    #[serde(default)]
    pub(crate) value: Option<f64>,
    #[serde(default)]
    pub(crate) parameters: Vec<f64>,
    #[serde(default, rename = "dataType")]
    pub(crate) data_type: Option<String>,
    #[serde(default, rename = "pollIntervalMs")]
    pub(crate) poll_interval_ms: Option<u64>,
    #[serde(default, rename = "chunkSize")]
    pub(crate) chunk_size: Option<usize>,
}

impl Command {
    fn stop() -> Self {
        Self {
            command_type: "stop".to_string(),
            request_id: None,
            subscription_generation: None,
            subscriptions: Vec::new(),
            aircraft: None,
            icao: None,
            region: None,
            name: None,
            code: None,
            unit: None,
            value: None,
            parameters: Vec::new(),
            data_type: None,
            poll_interval_ms: None,
            chunk_size: None,
        }
    }
}

// EOF is translated into a synthetic stop command so the main loop shuts down
// when its parent closes stdin instead of running as an orphan.
pub(crate) fn start_stdin_thread() -> Receiver<Command> {
    let (tx, rx) = stdin_command_channel();
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut stdin = stdin.lock();
        loop {
            let line = match read_limited_line(&mut stdin, MAX_STDIN_LINE_BYTES) {
                Ok(Some(Ok(line))) => line,
                Ok(Some(Err(error))) => {
                    crate::emit_value(json!({ "type": "error", "message": error }));
                    continue;
                }
                Ok(None) => break,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Command>(trimmed) {
                Ok(command) => {
                    if tx.send(command).is_err() {
                        break;
                    }
                }
                Err(err) => crate::emit_value(
                    json!({ "type": "error", "message": format!("invalid_json:{err}") }),
                ),
            }
        }
        let _ = tx.send(Command::stop());
    });
    rx
}

fn stdin_command_channel() -> (SyncSender<Command>, Receiver<Command>) {
    mpsc::sync_channel(MAX_PENDING_STDIN_COMMANDS)
}

pub(crate) fn receive_command_batch(
    receiver: &Receiver<Command>,
    max_commands: usize,
    wait: Duration,
) -> Vec<Command> {
    if max_commands == 0 {
        return Vec::new();
    }
    // Wake for the first command, then drain only a bounded batch. Serial
    // callers must not pay a whole telemetry interval for every axis ACK.
    match receiver.recv_timeout(wait) {
        Ok(first) => std::iter::once(first)
            .chain(receiver.try_iter().take(max_commands - 1))
            .collect(),
        Err(_) => Vec::new(),
    }
}

// Oversized input is drained through the next newline before reporting an
// error, which preserves framing for the command that follows it.
pub(crate) fn read_limited_line<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> io::Result<Option<Result<String, String>>> {
    let mut line = Vec::new();
    let mut too_long = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if too_long {
                return Ok(Some(Err("input_line_too_long".to_string())));
            }
            if line.is_empty() {
                return Ok(None);
            }
            return Ok(Some(Ok(String::from_utf8_lossy(&line).into_owned())));
        }

        let newline_index = available.iter().position(|byte| *byte == b'\n');
        let take_len = newline_index.map_or(available.len(), |index| index + 1);

        if !too_long {
            let remaining = max_bytes.saturating_sub(line.len());
            if take_len > remaining {
                line.extend_from_slice(&available[..remaining]);
                too_long = true;
            } else {
                line.extend_from_slice(&available[..take_len]);
            }
        }

        reader.consume(take_len);
        if newline_index.is_some() {
            break;
        }
    }

    if too_long {
        Ok(Some(Err("input_line_too_long".to_string())))
    } else {
        Ok(Some(Ok(String::from_utf8_lossy(&line).into_owned())))
    }
}

#[cfg(test)]
mod tests {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/unit/protocol-tests.rs"));
}
