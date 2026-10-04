//! Opt-in developer diagnostic. Never linked into the production PTT helper.
#[path = "../controller/mod.rs"]
mod controller;
#[cfg(test)]
use controller::Output as _;

use std::{
    io::{self, Write},
    sync::mpsc::{SyncSender, sync_channel},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq)]
struct Options {
    seconds: Option<u32>,
    device_path: Option<String>,
}

const USAGE: &str = "FlightFabric controller diagnostic (no audio or aircraft commands)\n\
Usage: flight-fabric-joystick-probe --list\n\
       flight-fabric-joystick-probe --watch --seconds <1..60> [--device-path <exact path>]";

fn options(args: impl IntoIterator<Item = String>) -> Result<Options, &'static str> {
    let mut args = args.into_iter();
    let mode = args.next().ok_or(USAGE)?;
    if mode == "--list" && args.next().is_none() {
        return Ok(Options {
            seconds: None,
            device_path: None,
        });
    }
    if mode != "--watch" {
        return Err(USAGE);
    }
    let mut seconds = None;
    let mut device_path = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seconds" if seconds.is_none() => {
                seconds = Some(
                    args.next()
                        .and_then(|v| v.parse::<u32>().ok())
                        .filter(|v| (1..=60).contains(v))
                        .ok_or(USAGE)?,
                );
            }
            "--device-path" if device_path.is_none() => {
                let path = args.next().ok_or(USAGE)?;
                if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
                    return Err("Device path is invalid");
                }
                device_path = Some(path);
            }
            _ => return Err(USAGE),
        }
    }
    if seconds.is_none() {
        return Err(USAGE);
    }
    Ok(Options {
        seconds,
        device_path,
    })
}

#[cfg(test)]
use controller::json_string;

struct Output {
    sender: SyncSender<String>,
    started: Instant,
    sequence: u64,
}

impl controller::Output for Output {
    fn emit(&mut self, fields: &str) -> Result<(), String> {
        self.sequence += 1;
        let line = format!(
            "{{\"sequence\":{},\"elapsedUs\":{},{fields}}}\n",
            self.sequence,
            self.started.elapsed().as_micros()
        );
        if line.len() > 32 * 1024 {
            return Err("Diagnostic event exceeded its size limit".into());
        }
        self.sender
            .try_send(line)
            .map_err(|_| "Diagnostic output stalled or closed; stopping input".into())
    }
}

fn main() {
    let options = match options(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    // Last-resort bound for OS calls and blocked stdout, including list-only.
    // Only this diagnostic process is terminated; it never opens another PID.
    let deadline = options.seconds.unwrap_or(10) + 3;
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(u64::from(deadline)));
        std::process::exit(1);
    });
    let (sender, receiver) = sync_channel::<String>(256);
    let writer = thread::spawn(move || -> io::Result<()> {
        let stdout = io::stdout();
        let mut stdout = stdout.lock();
        for line in receiver {
            stdout.write_all(line.as_bytes())?;
            stdout.flush()?;
        }
        Ok(())
    });
    let mut output = Output {
        sender,
        started: Instant::now(),
        sequence: 0,
    };
    #[cfg(windows)]
    let result = controller::windows::run(
        controller::Options {
            seconds: options.seconds,
            device_path: options.device_path,
            continuous: false,
            button: None,
            on_pause: |_| {},
        },
        &mut output,
    );
    #[cfg(not(windows))]
    let result: Result<(), String> = Err("This diagnostic requires Windows".into());
    drop(output);
    if let Err(error) = result {
        eprintln!("FlightFabric controller diagnostic: {error}");
        std::process::exit(1);
    }
    if !matches!(writer.join(), Ok(Ok(()))) {
        eprintln!("FlightFabric controller diagnostic: output could not be written");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(parts: &[&str]) -> Result<Options, &'static str> {
        options(parts.iter().map(|s| s.to_string()))
    }

    #[test]
    fn diagnostics_require_explicit_mode_and_bounded_duration() {
        assert_eq!(
            parse(&["--list"]),
            Ok(Options {
                seconds: None,
                device_path: None
            })
        );
        assert_eq!(
            parse(&["--watch", "--seconds", "5"]),
            Ok(Options {
                seconds: Some(5),
                device_path: None
            })
        );
        for args in [
            vec![],
            vec!["--watch"],
            vec!["--watch", "--seconds", "0"],
            vec!["--watch", "--seconds", "61"],
            vec!["--watch", "--seconds", "-1"],
            vec!["--list", "--watch"],
            vec!["--watch", "--seconds", "1", "--seconds", "2"],
            vec!["--watch", "--seconds", "1", "--device-path", "bad\npath"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn stalled_output_is_an_error_not_a_dropped_transition() {
        let (sender, _receiver) = sync_channel(1);
        let mut output = Output {
            sender,
            started: Instant::now(),
            sequence: 0,
        };
        output.emit("\"type\":\"press\"").unwrap();
        assert!(output.emit("\"type\":\"release\"").is_err());
    }

    #[test]
    fn device_strings_cannot_inject_output_lines() {
        assert_eq!(json_string("a\n\"\\\u{7f}"), "\"a\\u000a\\\"\\\\\\u007f\"");
    }
}
