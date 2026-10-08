#![cfg(windows)]

#[cfg(feature = "controller-ptt")]
mod controller;
#[cfg(feature = "controller-ptt")]
mod controller_runtime;
mod keyboard;
mod keyboard_raw;
#[cfg(feature = "controller-ptt")]
mod keyboard_thread;

use std::{
    env,
    io::{self, Write},
    sync::{
        OnceLock,
        mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
    },
    thread,
};

const MOD_CONTROL: u8 = 1;
const MOD_ALT: u8 = 2;
const MOD_SHIFT: u8 = 4;
const MOD_SUPER: u8 = 8;
const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0D;
const VK_CAPITAL: u32 = 0x14;
const VK_ESCAPE: u32 = 0x1B;
const VK_SPACE: u32 = 0x20;
const VK_PRIOR: u32 = 0x21;
const VK_NEXT: u32 = 0x22;
const VK_END: u32 = 0x23;
const VK_HOME: u32 = 0x24;
const VK_LEFT: u32 = 0x25;
const VK_UP: u32 = 0x26;
const VK_RIGHT: u32 = 0x27;
const VK_DOWN: u32 = 0x28;
const VK_INSERT: u32 = 0x2D;
const VK_DELETE: u32 = 0x2E;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const OUTPUT_QUEUE_CAPACITY: usize = 64;

// Fixed process status only: no diagnostic write is safe when stdout itself
// has failed. Keep these codes in sync with the Electron helper supervisor.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Failure {
    Startup = 10,
    Runtime = 11,
    OutputQueueFull = 12,
    OutputPipe = 13,
}

impl Failure {
    fn reason(self) -> &'static str {
        match self {
            Self::Startup => "startup-failure",
            Self::Runtime => "runtime-failure",
            Self::OutputQueueFull => "output-queue-full",
            Self::OutputPipe => "output-pipe-failure",
        }
    }
}

#[derive(Clone, Copy)]
struct HookConfig {
    key: u32,
    modifiers: u8,
}

#[derive(Clone, Debug, PartialEq)]
enum OutputEvent {
    Ready,
    Down,
    Up,
    KeyboardCancel(&'static str),
    Cancel(&'static str),
    Paused,
    Resumed,
    Stopped(Failure),
    #[cfg(feature = "controller-ptt")]
    Controller(String),
    End,
}

static OUTPUT_SENDER: OnceLock<SyncSender<OutputEvent>> = OnceLock::new();
impl OutputEvent {
    fn encoded(&self) -> Vec<u8> {
        match self {
            Self::Ready => b"{\"type\":\"ready\"}\n".to_vec(),
            Self::Down => b"{\"type\":\"down\"}\n".to_vec(),
            Self::Up => b"{\"type\":\"up\"}\n".to_vec(),
            Self::KeyboardCancel(reason) => {
                format!("{{\"type\":\"cancel\",\"source\":\"keyboard\",\"reason\":\"{reason}\"}}\n")
                    .into_bytes()
            }
            Self::Cancel(reason) => {
                format!("{{\"type\":\"cancel\",\"reason\":\"{reason}\"}}\n").into_bytes()
            }
            Self::Paused => b"{\"type\":\"paused\"}\n".to_vec(),
            Self::Resumed => b"{\"type\":\"resumed\"}\n".to_vec(),
            Self::Stopped(failure) => format!(
                "{{\"type\":\"stopped\",\"reason\":\"{}\"}}\n",
                failure.reason()
            )
            .into_bytes(),
            #[cfg(feature = "controller-ptt")]
            Self::Controller(fields) => format!("{{{fields}}}\n").into_bytes(),
            Self::End => Vec::new(),
        }
    }
}

fn write_output_events<W: Write>(mut writer: W, receiver: Receiver<OutputEvent>) -> io::Result<()> {
    for event in receiver {
        if event == OutputEvent::End {
            break;
        }
        writer.write_all(&event.encoded())?;
        writer.flush()?;
    }
    Ok(())
}

fn try_queue_output(sender: &SyncSender<OutputEvent>, event: OutputEvent) -> Result<(), Failure> {
    sender.try_send(event).map_err(|error| match error {
        TrySendError::Full(_) => Failure::OutputQueueFull,
        TrySendError::Disconnected(_) => Failure::OutputPipe,
    })
}

fn queue_output(event: OutputEvent) {
    let result = OUTPUT_SENDER
        .get()
        .ok_or(Failure::OutputPipe)
        .and_then(|sender| try_queue_output(sender, event));
    if let Err(failure) = result {
        // Never let a stalled or disconnected IPC pipe leave input registered.
        // This exits only the helper process; no external PID is opened or terminated.
        std::process::exit(failure as i32);
    }
}

fn is_pressed(key: i32) -> bool {
    (unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(key) } as u16
        & 0x8000)
        != 0
}

fn parse_key(value: &str) -> Result<u32, String> {
    let named = match value {
        "backspace" => Some(VK_BACK),
        "capslock" => Some(VK_CAPITAL),
        "tab" => Some(VK_TAB),
        "enter" => Some(VK_RETURN),
        "escape" | "esc" => Some(VK_ESCAPE),
        "space" | "spacebar" => Some(VK_SPACE),
        "pageup" => Some(VK_PRIOR),
        "pagedown" => Some(VK_NEXT),
        "end" => Some(VK_END),
        "home" => Some(VK_HOME),
        "left" => Some(VK_LEFT),
        "up" => Some(VK_UP),
        "right" => Some(VK_RIGHT),
        "down" => Some(VK_DOWN),
        "insert" => Some(VK_INSERT),
        "delete" | "del" => Some(VK_DELETE),
        "leftcontrol" => Some(VK_LCONTROL),
        "rightcontrol" => Some(VK_RCONTROL),
        "leftalt" => Some(VK_LMENU),
        "rightalt" => Some(VK_RMENU),
        "leftshift" => Some(VK_LSHIFT),
        "rightshift" => Some(VK_RSHIFT),
        "leftsuper" => Some(VK_LWIN),
        "rightsuper" => Some(VK_RWIN),
        _ => None,
    };
    if let Some(key) = named {
        return Ok(key);
    }
    if value.len() == 1 {
        let byte = value.as_bytes()[0];
        if byte.is_ascii_alphabetic() || byte.is_ascii_digit() {
            return Ok(byte.to_ascii_uppercase() as u32);
        }
    }
    if let Some(number) = value
        .strip_prefix('f')
        .and_then(|suffix| suffix.parse::<u32>().ok())
        && (1..=12).contains(&number)
    {
        return Ok(0x70 + number - 1);
    }
    Err("shortcut trigger key is not supported".to_string())
}

fn parse_shortcut(value: &str) -> Result<HookConfig, String> {
    let mut modifiers = 0_u8;
    let mut key = None;
    for part in value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let normalized = part.to_ascii_lowercase().replace([' ', '_', '-'], "");
        let modifier = match normalized.as_str() {
            "control" | "ctrl" | "commandorcontrol" | "cmdorctrl" => Some(MOD_CONTROL),
            "alt" => Some(MOD_ALT),
            "shift" => Some(MOD_SHIFT),
            "super" | "win" | "windows" => Some(MOD_SUPER),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if modifiers & modifier != 0 {
                return Err("shortcut repeats a modifier".to_string());
            }
            modifiers |= modifier;
        } else {
            if key.is_some() {
                return Err("shortcut has more than one trigger key".to_string());
            }
            key = Some(parse_key(&normalized)?);
        }
    }
    if key.is_none() {
        return Err("shortcut needs one trigger key".to_string());
    }
    Ok(HookConfig {
        key: key.unwrap_or_default(),
        modifiers,
    })
}

const USAGE: &str = "usage: flight-fabric-ptt-hook --shortcut <accelerator>";

fn parse_arguments<I: IntoIterator<Item = String>>(arguments: I) -> Result<String, String> {
    let mut arguments = arguments.into_iter();
    if arguments.next().as_deref() != Some("--shortcut") {
        return Err(USAGE.to_string());
    }
    let shortcut = arguments.next().ok_or_else(|| USAGE.to_string())?;
    if arguments.next().is_some() {
        return Err(USAGE.to_string());
    }
    Ok(shortcut)
}

fn initialize_output() -> thread::JoinHandle<()> {
    let (output_sender, output_receiver) = sync_channel(OUTPUT_QUEUE_CAPACITY);
    if OUTPUT_SENDER.set(output_sender).is_err() {
        std::process::exit(Failure::Startup as i32);
    }
    thread::Builder::new()
        .name("ptt-output".to_string())
        .spawn(move || {
            let stdout = io::stdout();
            if write_output_events(stdout.lock(), output_receiver).is_err() {
                // A broken parent pipe is fatal: input cannot be delivered.
                std::process::exit(Failure::OutputPipe as i32);
            }
        })
        .unwrap_or_else(|_| std::process::exit(Failure::Startup as i32))
}

fn main() {
    #[cfg(feature = "controller-ptt")]
    if std::env::args()
        .nth(1)
        .is_some_and(|arg| arg == "--controller-integration" || arg == "--controller-setup")
    {
        controller_runtime::run();
        return;
    }
    let arguments = parse_arguments(env::args().skip(1)).unwrap_or_else(|error| {
        eprintln!("[flight-fabric-ptt-hook] {error}");
        std::process::exit(2);
    });
    let config = parse_shortcut(&arguments).unwrap_or_else(|error| {
        eprintln!("[flight-fabric-ptt-hook] {error}");
        std::process::exit(2);
    });
    let writer = initialize_output();
    let result = keyboard_raw::run_standalone(config);
    if let Err(failure) = result {
        queue_output(OutputEvent::Stopped(failure));
    }
    queue_output(OutputEvent::End);
    let _ = writer.join();
    if let Err(failure) = result {
        std::process::exit(failure as i32);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::sync_channel;

    use super::{
        Failure, MOD_ALT, MOD_CONTROL, OutputEvent, VK_CAPITAL, VK_SPACE, parse_arguments,
        parse_shortcut, try_queue_output, write_output_events,
    };

    fn arguments(parts: &[&str]) -> Result<String, String> {
        parse_arguments(parts.iter().map(|part| part.to_string()))
    }

    #[test]
    fn parses_modified_shortcut() {
        let shortcut = parse_shortcut("Control+Alt+Space").expect("shortcut parses");
        assert_eq!(shortcut.key, VK_SPACE);
        assert_eq!(shortcut.modifiers, MOD_CONTROL | MOD_ALT);
    }

    #[test]
    fn parses_single_keys_with_optional_modifiers() {
        for (text, expected) in [
            ("CapsLock", VK_CAPITAL),
            ("caps lock", VK_CAPITAL),
            ("Space", VK_SPACE),
            ("a", 0x41),
            ("5", 0x35),
            ("F8", 0x77),
        ] {
            let shortcut = parse_shortcut(text).expect("single key parses");
            assert_eq!(shortcut.key, expected);
            assert_eq!(shortcut.modifiers, 0);
        }
        let shortcut = parse_shortcut("Control+CapsLock").unwrap();
        assert_eq!(shortcut.key, VK_CAPITAL);
        assert_eq!(shortcut.modifiers, MOD_CONTROL);
        for invalid in ["", "Control", "Control+Alt", "A+B", "Ctrl+Ctrl+A", "F13"] {
            assert!(parse_shortcut(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn parses_left_and_right_modifiers_as_single_trigger_keys() {
        for (text, expected) in [
            ("LeftControl", super::VK_LCONTROL),
            ("RightControl", super::VK_RCONTROL),
            ("LeftAlt", super::VK_LMENU),
            ("RightAlt", super::VK_RMENU),
            ("LeftShift", super::VK_LSHIFT),
            ("RightShift", super::VK_RSHIFT),
            ("LeftSuper", super::VK_LWIN),
            ("RightSuper", super::VK_RWIN),
        ] {
            let shortcut = parse_shortcut(text).unwrap();
            assert_eq!(shortcut.key, expected);
            assert_eq!(shortcut.modifiers, 0);
        }
        assert_eq!(parse_shortcut("left alt").unwrap().key, super::VK_LMENU);
    }

    #[test]
    fn serializes_output_events_in_order() {
        let (sender, receiver) = sync_channel(3);
        sender.send(OutputEvent::Ready).expect("ready is queued");
        sender.send(OutputEvent::Down).expect("down is queued");
        sender.send(OutputEvent::Up).expect("up is queued");
        drop(sender);

        let mut output = Vec::new();
        write_output_events(&mut output, receiver).expect("events are written");
        assert_eq!(
            output,
            b"{\"type\":\"ready\"}\n{\"type\":\"down\"}\n{\"type\":\"up\"}\n",
        );
    }

    #[test]
    fn output_queue_is_bounded_and_distinguishes_full_from_closed() {
        let (sender, receiver) = sync_channel(super::OUTPUT_QUEUE_CAPACITY);
        for _ in 0..super::OUTPUT_QUEUE_CAPACITY {
            assert_eq!(try_queue_output(&sender, OutputEvent::Down), Ok(()));
        }
        assert_eq!(
            try_queue_output(&sender, OutputEvent::Up),
            Err(Failure::OutputQueueFull)
        );
        // A blocked writer cannot make the hook wait for queue space.
        drop(receiver);
        assert_eq!(
            try_queue_output(&sender, OutputEvent::Up),
            Err(Failure::OutputPipe)
        );
    }

    #[test]
    fn terminal_reason_is_fixed_and_precedes_clean_writer_shutdown() {
        let (sender, receiver) = sync_channel(3);
        sender.send(OutputEvent::Ready).unwrap();
        sender.send(OutputEvent::Stopped(Failure::Runtime)).unwrap();
        sender.send(OutputEvent::End).unwrap();
        let mut output = Vec::new();
        write_output_events(&mut output, receiver).unwrap();
        assert_eq!(
            output,
            b"{\"type\":\"ready\"}\n{\"type\":\"stopped\",\"reason\":\"runtime-failure\"}\n"
        );
        assert_eq!(Failure::Startup as i32, 10);
        assert_eq!(Failure::Runtime as i32, 11);
        assert_eq!(Failure::OutputQueueFull as i32, 12);
        assert_eq!(Failure::OutputPipe as i32, 13);
    }

    #[test]
    fn writer_propagates_broken_pipe_without_a_diagnostic_write() {
        struct BrokenPipe(usize);
        impl std::io::Write for BrokenPipe {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                self.0 += 1;
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                panic!("failed writes must stop immediately");
            }
        }
        let (sender, receiver) = sync_channel(2);
        sender.send(OutputEvent::Down).unwrap();
        sender.send(OutputEvent::Up).unwrap();
        let mut writer = BrokenPipe(0);
        assert_eq!(
            write_output_events(&mut writer, receiver)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::BrokenPipe
        );
        assert_eq!(writer.0, 1);
    }

    #[test]
    fn keeps_the_keyboard_only_invocation() {
        assert_eq!(
            arguments(&["--shortcut", "Control+Alt+Space"]),
            Ok("Control+Alt+Space".to_string()),
        );
    }

    #[test]
    fn rejects_incomplete_or_mixed_invocations() {
        assert!(arguments(&[]).is_err());
        assert!(arguments(&["--shortcut"]).is_err());
        assert!(
            arguments(&[
                "--shortcut",
                "Control+Alt+Space",
                "--shortcut",
                "Control+Alt+F1"
            ])
            .is_err()
        );
        assert!(arguments(&["--surprise"]).is_err());
    }

    #[test]
    fn rejects_retired_joystick_modes() {
        for invocation in [
            vec!["--learn-joystick"],
            vec!["--joystick", "044F:B10A", "--button", "5"],
            vec![
                "--shortcut",
                "Control+Alt+Space",
                "--joystick",
                "044F:B10A",
                "--button",
                "5",
            ],
        ] {
            assert!(arguments(&invocation).is_err());
        }
    }
}
