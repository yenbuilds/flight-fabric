//! App integration uses the same parser as the opt-in diagnostic. Keyboard
//! input has a dedicated owner; both sources use bounded nonblocking output.
use super::*;
use controller::{Options, Output, reports::Button};

#[derive(Default)]
struct Events {
    ready: bool,
}
impl Output for Events {
    fn emit(&mut self, fields: &str) -> Result<(), String> {
        if fields.len() > 32 * 1024 - 3 {
            return Err("Controller event is too large".into());
        }
        if fields.starts_with("\"type\":\"ready\",") {
            self.ready = true;
        }
        queue_output(OutputEvent::Controller(fields.to_string()));
        Ok(())
    }
}

fn options(args: &[String]) -> Result<(Options, Option<HookConfig>), String> {
    let mut options = Options {
        seconds: None,
        device_path: None,
        continuous: true,
        button: None,
        on_pause: Box::new(|_| Ok(())),
    };
    if args == ["--controller-setup", "--seconds", "30"] {
        options.seconds = Some(30);
        options.continuous = false;
        return Ok((options, None));
    }
    if args.len() != 11
        || args[0] != "--controller-integration"
        || args[1] != "--shortcut"
        || args[3] != "--device-path"
        || args[5] != "--report-id"
        || args[7] != "--collection"
        || args[9] != "--button"
    {
        return Err("Invalid controller invocation".into());
    }
    if args[4].is_empty() || args[4].len() > 4096 || args[4].chars().any(char::is_control) {
        return Err("Invalid controller identity".into());
    }
    let button = Button {
        report_id: args[6].parse().map_err(|_| "Invalid report ID")?,
        collection: args[8].parse().map_err(|_| "Invalid collection")?,
        usage: args[10].parse().map_err(|_| "Invalid button")?,
    };
    if button.usage == 0 {
        return Err("Invalid button".into());
    }
    options.device_path = Some(args[4].clone());
    options.button = Some(button);
    let keyboard = if args[2].is_empty() {
        None
    } else {
        Some(parse_shortcut(&args[2])?)
    };
    Ok((options, keyboard))
}

pub fn run() {
    let (mut options, keyboard) =
        options(&env::args().skip(1).collect::<Vec<_>>()).unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(2);
        });
    let writer = initialize_output();
    let mut keyboard = match keyboard
        .map(keyboard_thread::KeyboardThread::start)
        .transpose()
    {
        Ok(keyboard) => keyboard,
        Err(failure) => {
            // A timed-out installer may still own a paused thread. Do not
            // drain output while its retirement remains unconfirmed.
            std::process::exit(failure as i32);
        }
    };
    if let Some(keyboard) = &keyboard {
        let control = keyboard.control();
        options.on_pause = Box::new(move |paused| {
            control
                .set_paused(paused)
                .map_err(|_| "Keyboard input thread did not respond".into())
        });
    }
    let mut events = Events::default();
    let result = controller::windows::run(options, &mut events);
    let stopped = keyboard.as_mut().map_or(Ok(()), |keyboard| keyboard.stop());
    finish_run(writer, events.ready, result, stopped);
}

fn finish_run(
    writer: thread::JoinHandle<()>,
    ready: bool,
    result: Result<(), String>,
    keyboard_stopped: Result<(), Failure>,
) {
    if let Err(failure) = keyboard_stopped {
        // Never send End or wait on stdout while a keyboard producer may
        // still run. Terminating this helper releases every registration/thread.
        std::process::exit(failure as i32);
    }
    let failure = result.err().map(|_| {
        if ready {
            Failure::Runtime
        } else {
            Failure::Startup
        }
    });
    if let Some(failure) = failure {
        queue_output(OutputEvent::Stopped(failure));
    }
    queue_output(OutputEvent::End);
    let _ = writer.join();
    if let Some(failure) = failure {
        std::process::exit(failure as i32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    #[test]
    fn unconfirmed_keyboard_shutdown_exits_without_waiting_for_the_writer() {
        const CHILD_FLAG: &str = "FF_PTT_UNCONFIRMED_SHUTDOWN_TEST";
        if env::var_os(CHILD_FLAG).is_some() {
            // Artificially stalled output is never joined if the input owner
            // has not acknowledged removal. No real input registration is made.
            let writer = thread::spawn(|| {
                loop {
                    thread::park();
                }
            });
            finish_run(writer, true, Ok(()), Err(Failure::Runtime));
            panic!("unconfirmed shutdown must terminate the helper");
        }
        let mut child = Command::new(env::current_exe().unwrap())
            .args(["--exact", "controller_runtime::tests::unconfirmed_keyboard_shutdown_exits_without_waiting_for_the_writer"])
            .env(CHILD_FLAG, "1")
            .creation_flags(0x08000000)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(status.code(), Some(Failure::Runtime as i32));
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("shutdown waited for the stalled output writer");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn only_exact_bounded_setup_or_complete_binding_is_accepted() {
        let parse =
            |args: &[&str]| options(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(parse(&["--controller-setup", "--seconds", "30"]).is_ok());
        assert!(parse(&["--controller-setup", "--seconds", "0"]).is_err());
        assert!(
            parse(&[
                "--controller-integration",
                "--shortcut",
                "Control+Alt+Space",
                "--device-path",
                "path",
                "--report-id",
                "255",
                "--collection",
                "65535",
                "--button",
                "65535"
            ])
            .is_ok()
        );
        assert!(
            parse(&[
                "--controller-integration",
                "--shortcut",
                "",
                "--device-path",
                "path",
                "--report-id",
                "256",
                "--collection",
                "0",
                "--button",
                "1"
            ])
            .is_err()
        );
    }
}
