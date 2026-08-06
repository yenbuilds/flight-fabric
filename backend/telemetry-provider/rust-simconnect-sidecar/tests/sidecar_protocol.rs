#![cfg(windows)]

use serde_json::Value;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn sidecar_process_keeps_invalid_and_valid_commands_in_ndjson_frames() {
    let owner_arg = format!("--ff-owner-pid={}", std::process::id());
    let mut child = Command::new(env!("CARGO_BIN_EXE_ff-rust-simconnect-sidecar"))
        .args(["--simvars-bridge", owner_arg.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("sidecar binary should start");
    let mut stdout = child.stdout.take().expect("stdout should be piped");
    let mut stderr = child.stderr.take().expect("stderr should be piped");
    let mut stdin = child.stdin.take().expect("stdin should be piped");
    stdin
        .write_all(
            b"not-json\n{\"type\":\"setSimVars\",\"subscriptions\":[{\"key\":\"ias\",\"simvar\":\"AIRSPEED INDICATED\",\"unit\":\"knots\"}]}\n{\"type\":\"stop\"}\n",
        )
        .expect("commands should be written");
    drop(stdin);

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().expect("sidecar status should be queryable") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("sidecar did not stop after receiving the stop command");
        }
        thread::sleep(Duration::from_millis(10));
    };

    let mut stdout_text = String::new();
    stdout
        .read_to_string(&mut stdout_text)
        .expect("sidecar stdout should be readable");
    let mut stderr_text = String::new();
    stderr
        .read_to_string(&mut stderr_text)
        .expect("sidecar stderr should be readable");
    assert!(
        status.success(),
        "sidecar exited with {status}; stderr: {stderr_text}"
    );

    let messages = stdout_text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str::<Value>(line)
                .unwrap_or_else(|error| panic!("stdout frame was not JSON: {line:?}: {error}"))
        })
        .collect::<Vec<_>>();

    assert!(messages.iter().any(|message| message["type"] == "ready"));
    assert!(messages.iter().any(|message| {
        message["type"] == "error"
            && message["message"]
                .as_str()
                .is_some_and(|value| value.starts_with("invalid_json:"))
    }));
    assert!(messages.iter().any(|message| {
        message["type"] == "status" && message["state"] == "simvars_updated"
    }));
}
