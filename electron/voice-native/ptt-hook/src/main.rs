#![cfg(windows)]

use std::{
    env,
    io::{self, Write},
    mem::MaybeUninit,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender},
        OnceLock,
    },
    thread,
};

const WH_KEYBOARD_LL: i32 = 13;
const HC_ACTION: i32 = 0;
const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_SYSKEYUP: u32 = 0x0105;
const MOD_CONTROL: u8 = 1;
const MOD_ALT: u8 = 2;
const MOD_SHIFT: u8 = 4;
const MOD_SUPER: u8 = 8;
const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0D;
const VK_SHIFT: i32 = 0x10;
const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12;
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
const VK_LWIN: i32 = 0x5B;
const VK_RWIN: i32 = 0x5C;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const OUTPUT_QUEUE_CAPACITY: usize = 64;

type HookHandle = isize;
type WindowHandle = isize;
type WParam = usize;
type LParam = isize;
type LResult = isize;

#[repr(C)]
struct Point { x: i32, y: i32 }

#[repr(C)]
struct Message {
    hwnd: WindowHandle,
    message: u32,
    w_param: WParam,
    l_param: LParam,
    time: u32,
    point: Point,
    l_private: u32,
}

#[repr(C)]
struct KeyboardLowLevelData {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}

type HookProcedure = Option<unsafe extern "system" fn(i32, WParam, LParam) -> LResult>;

#[link(name = "user32")]
unsafe extern "system" {
    fn SetWindowsHookExW(id_hook: i32, procedure: HookProcedure, module: isize, thread_id: u32) -> HookHandle;
    fn CallNextHookEx(hook: HookHandle, code: i32, w_param: WParam, l_param: LParam) -> LResult;
    fn UnhookWindowsHookEx(hook: HookHandle) -> i32;
    fn GetMessageW(message: *mut Message, window: WindowHandle, min: u32, max: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> i32;
    fn DispatchMessageW(message: *const Message) -> LResult;
    fn GetAsyncKeyState(key: i32) -> i16;
}

#[derive(Clone, Copy)]
struct HookConfig { key: u32, modifiers: u8 }

#[derive(Clone, Copy)]
enum OutputEvent { Ready, Down, Up }

static CONFIG: OnceLock<HookConfig> = OnceLock::new();
static OUTPUT_SENDER: OnceLock<SyncSender<OutputEvent>> = OnceLock::new();
static HELD: AtomicBool = AtomicBool::new(false);

impl OutputEvent {
    fn encoded(self) -> &'static [u8] {
        match self {
            Self::Ready => b"{\"type\":\"ready\"}\n",
            Self::Down => b"{\"type\":\"down\"}\n",
            Self::Up => b"{\"type\":\"up\"}\n",
        }
    }
}

fn write_output_events<W: Write>(mut writer: W, receiver: Receiver<OutputEvent>) -> io::Result<()> {
    for event in receiver {
        writer.write_all(event.encoded())?;
        writer.flush()?;
    }
    Ok(())
}

fn queue_output(event: OutputEvent) {
    let queued = OUTPUT_SENDER.get().is_some_and(|sender| sender.try_send(event).is_ok());
    if !queued {
        // Never let a stalled or disconnected IPC pipe make the global hook linger.
        // This exits only the helper process; no external PID is opened or terminated.
        std::process::exit(1);
    }
}

fn is_pressed(key: i32) -> bool {
    (unsafe { GetAsyncKeyState(key) } as u16 & 0x8000) != 0
}

fn modifiers_are_down(config: HookConfig) -> bool {
    (config.modifiers & MOD_CONTROL == 0 || is_pressed(VK_CONTROL))
        && (config.modifiers & MOD_ALT == 0 || is_pressed(VK_MENU))
        && (config.modifiers & MOD_SHIFT == 0 || is_pressed(VK_SHIFT))
        && (config.modifiers & MOD_SUPER == 0 || is_pressed(VK_LWIN) || is_pressed(VK_RWIN))
}

fn required_modifier(config: HookConfig, key: u32) -> bool {
    (config.modifiers & MOD_CONTROL != 0 && [VK_CONTROL as u32, VK_LCONTROL, VK_RCONTROL].contains(&key))
        || (config.modifiers & MOD_ALT != 0 && [VK_MENU as u32, VK_LMENU, VK_RMENU].contains(&key))
        || (config.modifiers & MOD_SHIFT != 0 && [VK_SHIFT as u32, VK_LSHIFT, VK_RSHIFT].contains(&key))
        || (config.modifiers & MOD_SUPER != 0 && [VK_LWIN as u32, VK_RWIN as u32].contains(&key))
}

unsafe extern "system" fn keyboard_hook(code: i32, w_param: WParam, l_param: LParam) -> LResult {
    if code != HC_ACTION || l_param == 0 {
        return unsafe { CallNextHookEx(0, code, w_param, l_param) };
    }
    let Some(config) = CONFIG.get().copied() else {
        return unsafe { CallNextHookEx(0, code, w_param, l_param) };
    };
    let event = unsafe { &*(l_param as *const KeyboardLowLevelData) };
    let message = w_param as u32;
    let is_down = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
    let is_up = matches!(message, WM_KEYUP | WM_SYSKEYUP);
    let held = HELD.load(Ordering::SeqCst);

    if event.vk_code == config.key && is_down && (held || modifiers_are_down(config)) {
        if !held {
            HELD.store(true, Ordering::SeqCst);
            queue_output(OutputEvent::Down);
        }
        return 1;
    }
    if HELD.load(Ordering::SeqCst)
        && is_up
        && (event.vk_code == config.key || required_modifier(config, event.vk_code))
    {
        HELD.store(false, Ordering::SeqCst);
        queue_output(OutputEvent::Up);
        if event.vk_code == config.key { return 1; }
    }
    unsafe { CallNextHookEx(0, code, w_param, l_param) }
}

fn parse_key(value: &str) -> Result<u32, String> {
    let named = match value {
        "backspace" => Some(VK_BACK), "tab" => Some(VK_TAB), "enter" => Some(VK_RETURN),
        "escape" | "esc" => Some(VK_ESCAPE), "space" | "spacebar" => Some(VK_SPACE),
        "pageup" => Some(VK_PRIOR), "pagedown" => Some(VK_NEXT), "end" => Some(VK_END),
        "home" => Some(VK_HOME), "left" => Some(VK_LEFT), "up" => Some(VK_UP),
        "right" => Some(VK_RIGHT), "down" => Some(VK_DOWN), "insert" => Some(VK_INSERT),
        "delete" | "del" => Some(VK_DELETE), _ => None,
    };
    if let Some(key) = named { return Ok(key); }
    if value.len() == 1 {
        let byte = value.as_bytes()[0];
        if byte.is_ascii_alphabetic() || byte.is_ascii_digit() { return Ok(byte.to_ascii_uppercase() as u32); }
    }
    if let Some(number) = value.strip_prefix('f').and_then(|suffix| suffix.parse::<u32>().ok())
        && (1..=12).contains(&number)
    {
        return Ok(0x70 + number - 1);
    }
    Err("shortcut trigger key is not supported".to_string())
}

fn parse_shortcut(value: &str) -> Result<HookConfig, String> {
    let mut modifiers = 0_u8;
    let mut key = None;
    for part in value.split('+').map(str::trim).filter(|part| !part.is_empty()) {
        let normalized = part.to_ascii_lowercase().replace([' ', '_', '-'], "");
        let modifier = match normalized.as_str() {
            "control" | "ctrl" | "commandorcontrol" | "cmdorctrl" => Some(MOD_CONTROL),
            "alt" => Some(MOD_ALT), "shift" => Some(MOD_SHIFT),
            "super" | "win" | "windows" => Some(MOD_SUPER), _ => None,
        };
        if let Some(modifier) = modifier {
            if modifiers & modifier != 0 { return Err("shortcut repeats a modifier".to_string()); }
            modifiers |= modifier;
        } else {
            if key.is_some() { return Err("shortcut has more than one trigger key".to_string()); }
            key = Some(parse_key(&normalized)?);
        }
    }
    if modifiers == 0 || key.is_none() { return Err("shortcut needs modifiers and one trigger key".to_string()); }
    Ok(HookConfig { key: key.unwrap_or_default(), modifiers })
}

fn shortcut_argument() -> Result<String, String> {
    let mut args = env::args().skip(1);
    match (args.next().as_deref(), args.next(), args.next()) {
        (Some("--shortcut"), Some(shortcut), None) => Ok(shortcut),
        _ => Err("usage: flight-fabric-ptt-hook --shortcut <accelerator>".to_string()),
    }
}

fn main() {
    let config = shortcut_argument().and_then(|shortcut| parse_shortcut(&shortcut)).unwrap_or_else(|error| {
        eprintln!("[flight-fabric-ptt-hook] {error}");
        std::process::exit(2);
    });
    let _ = CONFIG.set(config);
    let (output_sender, output_receiver) = sync_channel(OUTPUT_QUEUE_CAPACITY);
    if OUTPUT_SENDER.set(output_sender).is_err() {
        std::process::exit(1);
    }
    if thread::Builder::new()
        .name("ptt-output".to_string())
        .spawn(move || {
            let stdout = io::stdout();
            if write_output_events(stdout.lock(), output_receiver).is_err() {
                // A broken parent pipe is fatal: leaving the global hook active would
                // suppress the configured shortcut without delivering PTT events.
                std::process::exit(1);
            }
        })
        .is_err()
    {
        std::process::exit(1);
    }
    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), 0, 0) };
    if hook == 0 {
        eprintln!("[flight-fabric-ptt-hook] could not install the low-level keyboard hook");
        std::process::exit(1);
    }
    // Queue readiness before pumping hook callbacks so event order is deterministic.
    queue_output(OutputEvent::Ready);
    loop {
        let mut message = MaybeUninit::<Message>::zeroed();
        let result = unsafe { GetMessageW(message.as_mut_ptr(), 0, 0, 0) };
        if result <= 0 { break; }
        let message = unsafe { message.assume_init() };
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    unsafe { UnhookWindowsHookEx(hook) };
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::sync_channel;

    use super::{parse_shortcut, write_output_events, OutputEvent, MOD_ALT, MOD_CONTROL, VK_SPACE};

    #[test]
    fn parses_default_shortcut() {
        let shortcut = parse_shortcut("Control+Alt+Space").expect("shortcut parses");
        assert_eq!(shortcut.key, VK_SPACE);
        assert_eq!(shortcut.modifiers, MOD_CONTROL | MOD_ALT);
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
}
