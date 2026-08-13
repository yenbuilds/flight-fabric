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
    #[serde(default)]
    pub(crate) x: Option<f64>,
    #[serde(default)]
    pub(crate) y: Option<f64>,
    #[serde(default)]
    pub(crate) z: Option<f64>,
    #[serde(default)]
    pub(crate) units: Option<String>,
    #[serde(default)]
    pub(crate) pitch: Option<f64>,
    #[serde(default)]
    pub(crate) bank: Option<f64>,
    #[serde(default)]
    pub(crate) heading: Option<f64>,
    #[serde(default)]
    pub(crate) dx: Option<f64>,
    #[serde(default)]
    pub(crate) dy: Option<f64>,
    #[serde(default)]
    pub(crate) dz: Option<f64>,
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
            x: None,
            y: None,
            z: None,
            units: None,
            pitch: None,
            bank: None,
            heading: None,
            dx: None,
            dy: None,
            dz: None,
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
) -> Vec<Command> {
    receiver.try_iter().take(max_commands).collect()
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
    use super::*;

    #[test]
    fn command_deserialization_preserves_wire_names_and_defaults() {
        let command: Command = serde_json::from_str(
            r#"{
              "type":"setSimVars",
              "requestId":42,
              "subscriptions":[{"key":"ias","simvar":" AIRSPEED INDICATED ","unit":"knots","dataType":"float64"}],
              "pollIntervalMs":100,
              "chunkSize":8
            }"#,
        )
        .expect("command should parse");

        assert_eq!(command.command_type, "setSimVars");
        assert_eq!(command.request_id, Some(42));
        assert_eq!(command.subscription_generation, None);
        assert_eq!(command.poll_interval_ms, Some(100));
        assert_eq!(command.chunk_size, Some(8));
        assert_eq!(command.subscriptions.len(), 1);
        assert_eq!(command.subscriptions[0].reference(), "AIRSPEED INDICATED");
        assert_eq!(
            command.subscriptions[0].data_type.as_deref(),
            Some("float64")
        );
        assert!(command.name.is_none());
        assert!(command.code.is_none());
        assert!(command.value.is_none());
        assert!(command.parameters.is_empty());
        assert!(command.icao.is_none());
    }

    #[test]
    fn event_command_deserialization_preserves_additional_parameters() {
        let command: Command = serde_json::from_str(
            r#"{"type":"sendEvent","name":"HEADING_BUG_SET","value":275,"parameters":[0]}"#,
        )
        .expect("event command should parse");

        assert_eq!(command.command_type, "sendEvent");
        assert_eq!(command.name.as_deref(), Some("HEADING_BUG_SET"));
        assert_eq!(command.value, Some(275.0));
        assert_eq!(command.parameters, vec![0.0]);
    }

    #[test]
    fn subscription_generation_accepts_nonnegative_integers_and_rejects_negative_values() {
        let command: Command = serde_json::from_str(
            r#"{"type":"setSubscriptions","subscriptionGeneration":12,"subscriptions":[]}"#,
        )
        .expect("nonnegative subscription generation should parse");
        assert_eq!(command.subscription_generation, Some(12));

        let negative = serde_json::from_str::<Command>(
            r#"{"type":"setSubscriptions","subscriptionGeneration":-1,"subscriptions":[]}"#,
        );
        assert!(negative.is_err());
    }

    #[test]
    fn subscription_reference_prefers_expression_over_legacy_simvar() {
        let subscription = Subscription {
            key: "k".to_string(),
            expression: " (L:PRIMARY) ".to_string(),
            simvar: Some("SECONDARY".to_string()),
            unit: None,
            data_type: None,
            isolated: false,
        };
        assert_eq!(subscription.reference(), "(L:PRIMARY)");

        let legacy = Subscription {
            expression: " ".to_string(),
            simvar: Some(" LEGACY_SIMVAR ".to_string()),
            ..subscription
        };
        assert_eq!(legacy.reference(), "LEGACY_SIMVAR");
    }

    #[test]
    fn mobiflight_execution_command_preserves_code_and_request_id() {
        let command: Command = serde_json::from_str(
            r#"{"type":"executeMobiFlightCode","code":"1 (>K:ROTOR_BRAKE)","requestId":77}"#,
        )
        .expect("command should parse");

        assert_eq!(command.command_type, "executeMobiFlightCode");
        assert_eq!(command.code.as_deref(), Some("1 (>K:ROTOR_BRAKE)"));
        assert_eq!(command.request_id, Some(77));
    }

    #[test]
    fn stdin_reader_rejects_overlong_lines_without_unbounded_storage() {
        let mut reader = std::io::Cursor::new(b"{\"type\":\"probe\"}\n".to_vec());
        let line = read_limited_line(&mut reader, 64)
            .expect("read should succeed")
            .expect("line expected")
            .expect("line should be accepted");
        assert_eq!(line.trim(), "{\"type\":\"probe\"}");

        let mut reader = std::io::Cursor::new(b"0123456789\n{\"type\":\"stop\"}\n".to_vec());
        let first = read_limited_line(&mut reader, 4)
            .expect("read should succeed")
            .expect("first line expected");
        assert!(first
            .expect_err("first line should be rejected")
            .contains("input_line_too_long"));
        let second = read_limited_line(&mut reader, 64)
            .expect("read should succeed")
            .expect("second line expected")
            .expect("second line should remain readable");
        assert_eq!(second.trim(), "{\"type\":\"stop\"}");
    }

    #[test]
    fn stdin_reader_accepts_a_final_unterminated_command() {
        let mut reader = std::io::Cursor::new(b"{\"type\":\"stop\"}".to_vec());
        let line = read_limited_line(&mut reader, 64)
            .expect("read should succeed")
            .expect("final line expected")
            .expect("bounded final line should be accepted");
        assert_eq!(line, "{\"type\":\"stop\"}");
        assert!(read_limited_line(&mut reader, 64)
            .expect("subsequent EOF read should succeed")
            .is_none());
    }

    #[test]
    fn stdin_reader_reports_an_oversized_unterminated_line_once() {
        let mut reader = std::io::Cursor::new(vec![b'x'; 65]);
        let error = read_limited_line(&mut reader, 64)
            .expect("read should succeed")
            .expect("oversized final line expected")
            .expect_err("oversized final line should be rejected");
        assert_eq!(error, "input_line_too_long");
        assert!(read_limited_line(&mut reader, 64)
            .expect("subsequent EOF read should succeed")
            .is_none());
    }

    #[test]
    fn stdin_command_queue_is_bounded_and_batches_preserve_fifo_order() {
        let (sender, receiver) = stdin_command_channel();
        for index in 0..MAX_PENDING_STDIN_COMMANDS {
            let mut command = Command::stop();
            command.command_type = format!("command-{index}");
            sender
                .try_send(command)
                .expect("commands within the queue capacity should be accepted");
        }

        assert!(matches!(
            sender.try_send(Command::stop()),
            Err(mpsc::TrySendError::Full(_))
        ));

        let first_batch = receive_command_batch(&receiver, 7);
        assert_eq!(first_batch.len(), 7);
        for (index, command) in first_batch.iter().enumerate() {
            assert_eq!(command.command_type, format!("command-{index}"));
        }
        assert_eq!(
            receiver
                .try_recv()
                .expect("the batch limit must leave later commands queued")
                .command_type,
            "command-7"
        );
    }
}
