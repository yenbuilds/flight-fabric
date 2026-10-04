//! App integration uses the same parser as the opt-in diagnostic. Both input
//! sources enqueue on this thread, in message order; stdout never blocks hooks.
use super::*;
use controller::{Options, Output, reports::Button};

struct Events;
impl Output for Events {
    fn emit(&mut self, fields: &str) -> Result<(), String> {
        if fields.len() > 32 * 1024 - 3 {
            return Err("Controller event is too large".into());
        }
        queue_output(OutputEvent::Controller(fields.to_string()));
        Ok(())
    }
}

fn pause_keyboard(paused: bool) {
    PAUSED.store(paused, Ordering::SeqCst);
    HELD.store(false, Ordering::SeqCst);
    if let Some(config) = CONFIG.get() {
        ARMED.store(!is_pressed(config.key as i32), Ordering::SeqCst);
    }
}

fn options(args: &[String]) -> Result<(Options, Option<HookConfig>), String> {
    let mut options = Options {
        seconds: None,
        device_path: None,
        continuous: true,
        button: None,
        on_pause: pause_keyboard,
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
    let (options, keyboard) =
        options(&env::args().skip(1).collect::<Vec<_>>()).unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(2);
        });
    let writer = initialize_output();
    let hook = keyboard.map(|config| {
        let _ = CONFIG.set(config);
        ARMED.store(!is_pressed(config.key as i32), Ordering::SeqCst);
        unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), 0, 0) }
    });
    if hook == Some(0) {
        std::process::exit(1);
    }
    let result = controller::windows::run(options, &mut Events);
    if let Some(hook) = hook {
        unsafe { UnhookWindowsHookEx(hook) };
    }
    queue_output(OutputEvent::End);
    let _ = writer.join();
    if result.is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
