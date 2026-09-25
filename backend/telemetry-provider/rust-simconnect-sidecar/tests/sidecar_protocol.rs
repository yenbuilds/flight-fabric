#![cfg(windows)]

use serde_json::Value;
use std::io::{Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn wait_for_exit(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child
            .try_wait()
            .expect("sidecar status should be queryable")
        {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("sidecar did not stop within the test deadline");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn sidecar_process_keeps_invalid_and_valid_commands_in_ndjson_frames() {
    let owner_arg = format!("--ff-owner-pid={}", std::process::id());
    // The native exclusion lease is application state. Never create it in
    // the developer's real APPDATA during a protocol test.
    let app_data = std::env::temp_dir().join(format!("ff-sidecar-protocol-{}", std::process::id()));
    std::fs::create_dir_all(&app_data).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_ff-rust-simconnect-sidecar"))
        .args(["--simvars-bridge", owner_arg.as_str()])
        .env("APPDATA", &app_data)
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

    let status = wait_for_exit(&mut child);

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
    assert!(messages
        .iter()
        .any(|message| { message["type"] == "status" && message["state"] == "simvars_updated" }));
    std::fs::remove_file(app_data.join("Flight Fabric/Replay/simulator.lease")).unwrap();
    std::fs::remove_dir(app_data.join("Flight Fabric/Replay")).unwrap();
    std::fs::remove_dir(app_data.join("Flight Fabric")).unwrap();
    std::fs::remove_dir(app_data).unwrap();
}

#[test]
fn normal_bridge_processes_preserve_replay_exclusion_and_recovery_barriers() {
    let app_data =
        std::env::temp_dir().join(format!("ff-sidecar-replay-guard-{}", std::process::id()));
    let directory = app_data.join("Flight Fabric/Replay");
    std::fs::create_dir_all(&directory).unwrap();
    let lease_path = directory.join("simulator.lease");
    std::fs::write(&lease_path, b"").unwrap();
    let replay = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&lease_path)
        .unwrap();

    let assert_rejected = |expected_error: &str| {
        // All three normal simulator bridge entry points must reject before
        // opening SimConnect. No live simulator or aircraft writes are needed.
        for mode in [
            None,
            Some("--simvars-bridge"),
            Some("--sdk-clientdata-bridge"),
        ] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_ff-rust-simconnect-sidecar"));
            command
                .args(mode)
                .env("APPDATA", &app_data)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            let mut child = command.spawn().unwrap();
            let status = wait_for_exit(&mut child);
            let mut error = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut error)
                .unwrap();
            assert_eq!(status.code(), Some(3), "{mode:?}: {error}");
            assert!(error.contains(expected_error), "{mode:?}: {error}");
        }
    };
    assert_rejected("Simulator lease is in use");
    drop(replay);
    // The file existing is not itself ownership: after replay closes, only
    // a durable recovery marker should continue to block normal starts.
    std::fs::write(directory.join("recovery.json"), b"").unwrap();
    assert_rejected("Replay recovery is required");
    assert_eq!(std::fs::metadata(&lease_path).unwrap().len(), 0);
    std::fs::remove_file(directory.join("recovery.json")).unwrap();
    // No failed child left a shared handle behind.
    let exclusive = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&lease_path)
        .unwrap();
    drop(exclusive);
    std::fs::remove_file(lease_path).unwrap();
    std::fs::remove_dir(directory).unwrap();
    std::fs::remove_dir(app_data.join("Flight Fabric")).unwrap();
    std::fs::remove_dir(app_data).unwrap();
}
