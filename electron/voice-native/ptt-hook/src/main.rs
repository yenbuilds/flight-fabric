#![cfg(windows)]

use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::c_void,
    io::{self, Write},
    mem::MaybeUninit,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    thread,
    time::Duration,
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

// Joysticks are read through the HID class driver, the same shared handle any
// other program (including the simulator) can hold at the same time.
const GUID_DEVINTERFACE_HID: Guid = Guid {
    data1: 0x4D1E_55B2,
    data2: 0xF16F,
    data3: 0x11CF,
    data4: [0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30],
};
const CR_SUCCESS: u32 = 0;
const CR_BUFFER_SMALL: u32 = 0x1A;
const CM_GET_DEVICE_INTERFACE_LIST_PRESENT: u32 = 0;
const GENERIC_READ: u32 = 0x8000_0000;
const FILE_SHARE_READ: u32 = 0x1;
const FILE_SHARE_WRITE: u32 = 0x2;
const OPEN_EXISTING: u32 = 3;
const INVALID_HANDLE_VALUE: isize = -1;
const HIDP_INPUT: i32 = 0;
const HIDP_STATUS_SUCCESS: i32 = 0x0011_0000;
const USAGE_PAGE_GENERIC_DESKTOP: u16 = 0x01;
const USAGE_PAGE_BUTTON: u16 = 0x09;
const USAGE_JOYSTICK: u16 = 0x04;
const USAGE_GAMEPAD: u16 = 0x05;
const USAGE_MULTI_AXIS_CONTROLLER: u16 = 0x08;
const SOURCE_KEYBOARD: u8 = 1;
const SOURCE_JOYSTICK: u8 = 2;
const JOYSTICK_RESCAN_INTERVAL: Duration = Duration::from_millis(1000);
const JOYSTICK_REJECTED_RETRY_SCANS: u32 = 10;
const MAX_JOYSTICK_NAME_CHARS: usize = 64;
const MAX_JOYSTICK_PATH_CHARS: usize = 260;
const MAX_JOYSTICK_BUTTON: u16 = 512;
// Release hold: see docs/JOYSTICK-PTT-REVIEW-2026-09-20.md. This guard also
// protects direct invocations and older desktop clients with saved bindings.
const JOYSTICK_PUSH_TO_TALK_ENABLED: bool = false;

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

#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

#[repr(C)]
#[derive(Default)]
struct HiddAttributes {
    size: u32,
    vendor_id: u16,
    product_id: u16,
    version_number: u16,
}

#[repr(C)]
#[derive(Default)]
struct HidpCaps {
    usage: u16,
    usage_page: u16,
    input_report_byte_length: u16,
    output_report_byte_length: u16,
    feature_report_byte_length: u16,
    reserved: [u16; 17],
    number_link_collection_nodes: u16,
    number_input_button_caps: u16,
    number_input_value_caps: u16,
    number_input_data_indices: u16,
    number_output_button_caps: u16,
    number_output_value_caps: u16,
    number_output_data_indices: u16,
    number_feature_button_caps: u16,
    number_feature_value_caps: u16,
    number_feature_data_indices: u16,
}

const _: () = assert!(std::mem::size_of::<HidpCaps>() == 64);
const _: () = assert!(std::mem::size_of::<HiddAttributes>() == 12);

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

#[link(name = "cfgmgr32")]
unsafe extern "system" {
    fn CM_Get_Device_Interface_List_SizeW(length: *mut u32, interface_class: *const Guid, device_id: *const u16, flags: u32) -> u32;
    fn CM_Get_Device_Interface_ListW(interface_class: *const Guid, device_id: *const u16, buffer: *mut u16, length: u32, flags: u32) -> u32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(file_name: *const u16, desired_access: u32, share_mode: u32, security: *const c_void, creation: u32, flags: u32, template: isize) -> isize;
    fn ReadFile(handle: isize, buffer: *mut u8, bytes_to_read: u32, bytes_read: *mut u32, overlapped: *mut c_void) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}

#[link(name = "hid")]
unsafe extern "system" {
    fn HidD_GetAttributes(device: isize, attributes: *mut HiddAttributes) -> u8;
    fn HidD_GetProductString(device: isize, buffer: *mut u16, buffer_length: u32) -> u8;
    fn HidD_GetInputReport(device: isize, report: *mut u8, report_length: u32) -> u8;
    fn HidD_GetPreparsedData(device: isize, preparsed: *mut *mut c_void) -> u8;
    fn HidD_FreePreparsedData(preparsed: *mut c_void) -> u8;
    fn HidP_GetCaps(preparsed: *mut c_void, caps: *mut HidpCaps) -> i32;
    fn HidP_MaxUsageListLength(report_type: i32, usage_page: u16, preparsed: *mut c_void) -> u32;
    fn HidP_GetUsages(report_type: i32, usage_page: u16, link_collection: u16, usage_list: *mut u16, usage_length: *mut u32, preparsed: *mut c_void, report: *mut u8, report_length: u32) -> i32;
}

#[derive(Clone, Copy)]
struct HookConfig { key: u32, modifiers: u8 }

#[derive(Clone, Debug, PartialEq)]
struct JoystickBinding {
    vendor_id: u16,
    product_id: u16,
    button: u16,
    path: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct JoystickIdentity {
    path: String,
    vendor_id: u16,
    product_id: u16,
    name: String,
    buttons: u32,
}

#[derive(Debug, PartialEq)]
struct HelperArguments {
    shortcut: Option<String>,
    joystick: Option<JoystickBinding>,
    learn: bool,
}

#[derive(Clone)]
enum JoystickMode { Learn, PushToTalk(JoystickBinding) }

#[derive(Clone, Debug, PartialEq)]
enum OutputEvent {
    Ready,
    Down,
    Up,
    Device { identity: JoystickIdentity, connected: bool },
    Button { identity: JoystickIdentity, button: u16, down: bool },
}

static CONFIG: OnceLock<HookConfig> = OnceLock::new();
static OUTPUT_SENDER: OnceLock<SyncSender<OutputEvent>> = OnceLock::new();
static HELD: AtomicBool = AtomicBool::new(false);
// Which sources currently hold push-to-talk. The parent sees one "down" when
// the first source presses and one "up" when the last source releases.
static PRESSED_SOURCES: AtomicU8 = AtomicU8::new(0);

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            character if (character as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", character as u32)),
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

impl JoystickIdentity {
    fn json_fields(&self) -> String {
        format!(
            "\"vendorId\":\"{:04X}\",\"productId\":\"{:04X}\",\"name\":{},\"path\":{},\"buttons\":{}",
            self.vendor_id,
            self.product_id,
            json_string(&self.name),
            json_string(&self.path),
            self.buttons,
        )
    }
}

impl OutputEvent {
    fn encoded(&self) -> Vec<u8> {
        match self {
            Self::Ready => b"{\"type\":\"ready\"}\n".to_vec(),
            Self::Down => b"{\"type\":\"down\"}\n".to_vec(),
            Self::Up => b"{\"type\":\"up\"}\n".to_vec(),
            Self::Device { identity, connected } => {
                format!("{{\"type\":\"device\",\"connected\":{connected},{}}}\n", identity.json_fields()).into_bytes()
            }
            Self::Button { identity, button, down } => {
                format!("{{\"type\":\"button\",{},\"button\":{button},\"down\":{down}}}\n", identity.json_fields()).into_bytes()
            }
        }
    }
}

fn write_output_events<W: Write>(mut writer: W, receiver: Receiver<OutputEvent>) -> io::Result<()> {
    for event in receiver {
        writer.write_all(&event.encoded())?;
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

fn press_source(source: u8) {
    if PRESSED_SOURCES.fetch_or(source, Ordering::SeqCst) == 0 {
        queue_output(OutputEvent::Down);
    }
}

fn release_source(source: u8) {
    let previous = PRESSED_SOURCES.fetch_and(!source, Ordering::SeqCst);
    if previous & source != 0 && previous & !source == 0 {
        queue_output(OutputEvent::Up);
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
            press_source(SOURCE_KEYBOARD);
        }
        return 1;
    }
    if HELD.load(Ordering::SeqCst)
        && is_up
        && (event.vk_code == config.key || required_modifier(config, event.vk_code))
    {
        HELD.store(false, Ordering::SeqCst);
        release_source(SOURCE_KEYBOARD);
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

fn parse_joystick_id(value: &str) -> Result<(u16, u16), String> {
    let invalid = || "joystick id must be <VID>:<PID> with four hex digits each".to_string();
    let (vendor, product) = value.split_once(':').ok_or_else(invalid)?;
    let parse = |part: &str| {
        if part.len() != 4 || !part.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(invalid()); }
        u16::from_str_radix(part, 16).map_err(|_| invalid())
    };
    Ok((parse(vendor)?, parse(product)?))
}

fn parse_button(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|button| (1..=MAX_JOYSTICK_BUTTON).contains(button))
        .ok_or_else(|| format!("joystick button must be a number from 1 to {MAX_JOYSTICK_BUTTON}"))
}

fn parse_device_path(value: &str) -> Result<String, String> {
    if value.is_empty() || value.chars().count() > MAX_JOYSTICK_PATH_CHARS || value.chars().any(char::is_control) {
        return Err("joystick device path is not usable".to_string());
    }
    Ok(value.to_string())
}

const USAGE: &str = "usage: flight-fabric-ptt-hook [--shortcut <accelerator>] \
[--joystick <VID>:<PID> --button <n> [--device-path <path>]] | --learn-joystick";

fn parse_arguments<I: IntoIterator<Item = String>>(arguments: I) -> Result<HelperArguments, String> {
    let mut arguments = arguments.into_iter();
    let mut shortcut = None;
    let mut joystick_id = None;
    let mut button = None;
    let mut path = None;
    let mut learn = false;
    while let Some(flag) = arguments.next() {
        let mut value_for = |name: &str| arguments.next().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--shortcut" if shortcut.is_none() => shortcut = Some(value_for("--shortcut")?),
            "--joystick" if joystick_id.is_none() => joystick_id = Some(parse_joystick_id(&value_for("--joystick")?)?),
            "--button" if button.is_none() => button = Some(parse_button(&value_for("--button")?)?),
            "--device-path" if path.is_none() => path = Some(parse_device_path(&value_for("--device-path")?)?),
            "--learn-joystick" if !learn => learn = true,
            _ => return Err(USAGE.to_string()),
        }
    }
    if learn {
        if shortcut.is_some() || joystick_id.is_some() || button.is_some() || path.is_some() {
            return Err(USAGE.to_string());
        }
        return Ok(HelperArguments { shortcut: None, joystick: None, learn: true });
    }
    let joystick = match (joystick_id, button) {
        (Some((vendor_id, product_id)), Some(button)) => Some(JoystickBinding { vendor_id, product_id, button, path }),
        (None, None) if path.is_none() => None,
        _ => return Err(USAGE.to_string()),
    };
    if shortcut.is_none() && joystick.is_none() { return Err(USAGE.to_string()); }
    Ok(HelperArguments { shortcut, joystick, learn: false })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct DeviceHandle(isize);

impl DeviceHandle {
    fn open(path: &str) -> Option<Self> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateFileW(wide.as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ptr::null(), OPEN_EXISTING, 0, 0)
        };
        (handle != INVALID_HANDLE_VALUE && handle != 0).then_some(Self(handle))
    }
}

impl Drop for DeviceHandle {
    fn drop(&mut self) { unsafe { CloseHandle(self.0) }; }
}

struct PreparsedData(*mut c_void);

impl Drop for PreparsedData {
    fn drop(&mut self) { unsafe { HidD_FreePreparsedData(self.0) }; }
}

// The preparsed data is an opaque, immutable blob owned by this process.
unsafe impl Send for PreparsedData {}

struct OpenJoystick {
    identity: JoystickIdentity,
    handle: DeviceHandle,
    preparsed: PreparsedData,
    report_length: usize,
    max_usages: usize,
}

fn enumerate_hid_interface_paths() -> Vec<String> {
    loop {
        let mut length = 0_u32;
        let sized = unsafe {
            CM_Get_Device_Interface_List_SizeW(&mut length, &GUID_DEVINTERFACE_HID, ptr::null(), CM_GET_DEVICE_INTERFACE_LIST_PRESENT)
        };
        if sized != CR_SUCCESS || length == 0 { return Vec::new(); }
        let mut buffer = vec![0_u16; length as usize];
        let listed = unsafe {
            CM_Get_Device_Interface_ListW(&GUID_DEVINTERFACE_HID, ptr::null(), buffer.as_mut_ptr(), length, CM_GET_DEVICE_INTERFACE_LIST_PRESENT)
        };
        if listed == CR_BUFFER_SMALL { continue; }
        if listed != CR_SUCCESS { return Vec::new(); }
        return buffer
            .split(|&unit| unit == 0)
            .filter(|entry| !entry.is_empty())
            .map(String::from_utf16_lossy)
            .filter(|path| path.chars().count() <= MAX_JOYSTICK_PATH_CHARS)
            .collect();
    }
}

fn clean_product_name(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|character| !character.is_control()).collect();
    let cleaned: String = cleaned.trim().chars().take(MAX_JOYSTICK_NAME_CHARS).collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn product_name(handle: &DeviceHandle) -> Option<String> {
    let mut buffer = [0_u16; 256];
    let fetched = unsafe {
        HidD_GetProductString(handle.0, buffer.as_mut_ptr(), (buffer.len() * std::mem::size_of::<u16>()) as u32)
    };
    if fetched == 0 { return None; }
    let end = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
    clean_product_name(&String::from_utf16_lossy(&buffer[..end]))
}

fn open_joystick(path: &str) -> Option<OpenJoystick> {
    let handle = DeviceHandle::open(path)?;
    let mut attributes = HiddAttributes { size: std::mem::size_of::<HiddAttributes>() as u32, ..HiddAttributes::default() };
    if unsafe { HidD_GetAttributes(handle.0, &mut attributes) } == 0 { return None; }
    let mut raw = ptr::null_mut();
    if unsafe { HidD_GetPreparsedData(handle.0, &mut raw) } == 0 || raw.is_null() { return None; }
    let preparsed = PreparsedData(raw);
    let mut caps = HidpCaps::default();
    if unsafe { HidP_GetCaps(preparsed.0, &mut caps) } != HIDP_STATUS_SUCCESS { return None; }
    if caps.usage_page != USAGE_PAGE_GENERIC_DESKTOP
        || !matches!(caps.usage, USAGE_JOYSTICK | USAGE_GAMEPAD | USAGE_MULTI_AXIS_CONTROLLER)
        || caps.input_report_byte_length == 0
    {
        return None;
    }
    let buttons = unsafe { HidP_MaxUsageListLength(HIDP_INPUT, USAGE_PAGE_BUTTON, preparsed.0) };
    if buttons == 0 { return None; }
    let name = product_name(&handle)
        .unwrap_or_else(|| format!("Game controller {:04X}:{:04X}", attributes.vendor_id, attributes.product_id));
    Some(OpenJoystick {
        identity: JoystickIdentity {
            path: path.to_string(),
            vendor_id: attributes.vendor_id,
            product_id: attributes.product_id,
            name,
            buttons,
        },
        handle,
        preparsed,
        report_length: usize::from(caps.input_report_byte_length),
        max_usages: buttons as usize,
    })
}

fn pressed_buttons(device: &OpenJoystick, report: &mut [u8], usages: &mut [u16]) -> Option<Vec<u16>> {
    let mut length = usages.len() as u32;
    let status = unsafe {
        HidP_GetUsages(
            HIDP_INPUT, USAGE_PAGE_BUTTON, 0, usages.as_mut_ptr(), &mut length,
            device.preparsed.0, report.as_mut_ptr(), report.len() as u32,
        )
    };
    // Reports whose ID carries no buttons say nothing about them; skip those.
    if status != HIDP_STATUS_SUCCESS { return None; }
    let mut pressed = usages[..(length as usize).min(usages.len())].to_vec();
    pressed.sort_unstable();
    pressed.dedup();
    Some(pressed)
}

fn diff_buttons(previous: &[u16], current: &[u16], on_change: &mut impl FnMut(u16, bool)) {
    for &button in previous {
        if !current.contains(&button) { on_change(button, false); }
    }
    for &button in current {
        if !previous.contains(&button) { on_change(button, true); }
    }
}

// Blocks on the device until it goes away. Buttons already held when reading
// starts count as the baseline, so a button held during launch cannot start a
// press until it is released and pressed again.
fn read_joystick_reports(device: &OpenJoystick, mut on_change: impl FnMut(u16, bool)) {
    let mut report = vec![0_u8; device.report_length];
    let mut usages = vec![0_u16; device.max_usages];
    let mut state_by_report_id: HashMap<u8, Vec<u16>> = HashMap::new();
    let baseline = unsafe { HidD_GetInputReport(device.handle.0, report.as_mut_ptr(), report.len() as u32) };
    if baseline != 0 && let Some(pressed) = pressed_buttons(device, &mut report, &mut usages) {
        state_by_report_id.insert(report[0], pressed);
    }
    loop {
        let mut read = 0_u32;
        let ok = unsafe { ReadFile(device.handle.0, report.as_mut_ptr(), report.len() as u32, &mut read, ptr::null_mut()) };
        if ok == 0 { return; }
        if read == 0 { continue; }
        let Some(pressed) = pressed_buttons(device, &mut report[..read as usize], &mut usages) else { continue; };
        if let Some(previous) = state_by_report_id.get(&report[0]) {
            diff_buttons(previous, &pressed, &mut on_change);
        }
        state_by_report_id.insert(report[0], pressed);
    }
}

fn binding_candidates(paths: &[String], binding: &JoystickBinding) -> Vec<String> {
    let id = format!("vid_{:04x}&pid_{:04x}", binding.vendor_id, binding.product_id);
    let preferred = binding.path.as_deref().map(str::to_ascii_lowercase);
    let mut candidates: Vec<String> = paths
        .iter()
        .filter(|path| path.to_ascii_lowercase().contains(&id))
        .cloned()
        .collect();
    // The recorded path wins when it is present; a stick moved to another USB
    // port keeps working through the vendor/product match.
    candidates.sort_by_key(|path| preferred.as_deref() != Some(path.to_ascii_lowercase().as_str()));
    candidates
}

fn spawn_joystick_reader(device: OpenJoystick, mode: JoystickMode, active: Arc<Mutex<HashSet<String>>>) {
    let identity = device.identity.clone();
    queue_output(OutputEvent::Device { identity: identity.clone(), connected: true });
    let registry = Arc::clone(&active);
    let spawned = thread::Builder::new().name("ptt-joystick".to_string()).spawn(move || {
        let bound_button = match &mode {
            JoystickMode::PushToTalk(binding) => Some(binding.button),
            JoystickMode::Learn => None,
        };
        read_joystick_reports(&device, |button, down| match bound_button {
            Some(bound) if button == bound => {
                if down { press_source(SOURCE_JOYSTICK) } else { release_source(SOURCE_JOYSTICK) }
            }
            Some(_) => {}
            None => queue_output(OutputEvent::Button { identity: device.identity.clone(), button, down }),
        });
        // The device went away; an unplugged stick must not leave the microphone open.
        if bound_button.is_some() { release_source(SOURCE_JOYSTICK); }
        lock(&registry).remove(&device.identity.path);
        queue_output(OutputEvent::Device { identity: device.identity.clone(), connected: false });
    });
    if spawned.is_err() {
        lock(&active).remove(&identity.path);
        queue_output(OutputEvent::Device { identity, connected: false });
    }
}

fn run_joystick_supervisor(mode: JoystickMode) -> ! {
    let active: Arc<Mutex<HashSet<String>>> = Arc::default();
    let mut rejected_until: HashMap<String, u32> = HashMap::new();
    let mut scan = 0_u32;
    loop {
        let paths = enumerate_hid_interface_paths();
        let candidates = match &mode {
            JoystickMode::Learn => paths,
            JoystickMode::PushToTalk(binding) => binding_candidates(&paths, binding),
        };
        let single = matches!(mode, JoystickMode::PushToTalk(_));
        for path in candidates {
            if single && !lock(&active).is_empty() { break; }
            if lock(&active).contains(&path) { continue; }
            if rejected_until.get(&path).is_some_and(|&retry_at| scan < retry_at) { continue; }
            match open_joystick(&path) {
                Some(device) => {
                    rejected_until.remove(&path);
                    lock(&active).insert(path.clone());
                    spawn_joystick_reader(device, mode.clone(), Arc::clone(&active));
                }
                None => {
                    rejected_until.insert(path, scan.wrapping_add(JOYSTICK_REJECTED_RETRY_SCANS));
                }
            }
        }
        scan = scan.wrapping_add(1);
        thread::sleep(JOYSTICK_RESCAN_INTERVAL);
    }
}

fn main() {
    let arguments = parse_arguments(env::args().skip(1)).unwrap_or_else(|error| {
        eprintln!("[flight-fabric-ptt-hook] {error}");
        std::process::exit(2);
    });
    // Reject before starting threads, installing hooks or opening any device.
    if !JOYSTICK_PUSH_TO_TALK_ENABLED && (arguments.learn || arguments.joystick.is_some()) {
        eprintln!("[flight-fabric-ptt-hook] joystick push-to-talk is disabled in this release");
        std::process::exit(2);
    }
    let shortcut = arguments.shortcut.as_deref().map(parse_shortcut).transpose().unwrap_or_else(|error| {
        eprintln!("[flight-fabric-ptt-hook] {error}");
        std::process::exit(2);
    });
    if let Some(config) = shortcut {
        let _ = CONFIG.set(config);
    }
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
    let hook = shortcut.map(|_| {
        let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), 0, 0) };
        if hook == 0 {
            eprintln!("[flight-fabric-ptt-hook] could not install the low-level keyboard hook");
            std::process::exit(1);
        }
        hook
    });
    // Queue readiness before pumping hook callbacks so event order is deterministic.
    queue_output(OutputEvent::Ready);
    if arguments.learn {
        run_joystick_supervisor(JoystickMode::Learn);
    }
    if let Some(binding) = arguments.joystick {
        let mode = JoystickMode::PushToTalk(binding);
        if hook.is_none() {
            run_joystick_supervisor(mode);
        }
        if thread::Builder::new()
            .name("ptt-joystick-scan".to_string())
            .spawn(move || run_joystick_supervisor(mode))
            .is_err()
        {
            std::process::exit(1);
        }
    }
    let Some(hook) = hook else { std::process::exit(1) };
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
    use std::sync::{atomic::Ordering, mpsc::sync_channel};

    use super::{
        binding_candidates, clean_product_name, diff_buttons, json_string, parse_arguments, parse_shortcut,
        write_output_events, HelperArguments, JoystickBinding, JoystickIdentity, OutputEvent, MOD_ALT,
        MOD_CONTROL, PRESSED_SOURCES, VK_SPACE,
    };

    fn arguments(parts: &[&str]) -> Result<HelperArguments, String> {
        parse_arguments(parts.iter().map(|part| part.to_string()))
    }

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

    #[test]
    fn keeps_the_keyboard_only_invocation() {
        assert_eq!(
            arguments(&["--shortcut", "Control+Alt+Space"]),
            Ok(HelperArguments { shortcut: Some("Control+Alt+Space".to_string()), joystick: None, learn: false }),
        );
    }

    #[test]
    fn parses_joystick_bindings_with_and_without_a_shortcut() {
        let binding = JoystickBinding { vendor_id: 0x044F, product_id: 0xB10A, button: 5, path: None };
        assert_eq!(
            arguments(&["--joystick", "044f:B10A", "--button", "5"]),
            Ok(HelperArguments { shortcut: None, joystick: Some(binding.clone()), learn: false }),
        );
        assert_eq!(
            arguments(&["--shortcut", "Control+Alt+Space", "--joystick", "044F:B10A", "--button", "5", "--device-path", "\\\\?\\hid#vid_044f&pid_b10a#9&764e407&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}"]),
            Ok(HelperArguments {
                shortcut: Some("Control+Alt+Space".to_string()),
                joystick: Some(JoystickBinding {
                    path: Some("\\\\?\\hid#vid_044f&pid_b10a#9&764e407&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}".to_string()),
                    ..binding
                }),
                learn: false,
            }),
        );
        assert_eq!(arguments(&["--learn-joystick"]), Ok(HelperArguments { shortcut: None, joystick: None, learn: true }));
    }

    #[test]
    fn rejects_incomplete_or_mixed_invocations() {
        assert!(arguments(&[]).is_err());
        assert!(arguments(&["--joystick", "044F:B10A"]).is_err(), "a joystick needs a button");
        assert!(arguments(&["--button", "5"]).is_err(), "a button needs a joystick");
        assert!(arguments(&["--joystick", "044F:B10A", "--button", "0"]).is_err());
        assert!(arguments(&["--joystick", "044F:B10A", "--button", "513"]).is_err());
        assert!(arguments(&["--joystick", "44F:B10A", "--button", "1"]).is_err());
        assert!(arguments(&["--joystick", "044F-B10A", "--button", "1"]).is_err());
        assert!(arguments(&["--learn-joystick", "--shortcut", "Control+Alt+Space"]).is_err());
        assert!(arguments(&["--shortcut", "Control+Alt+Space", "--shortcut", "Control+Alt+F1"]).is_err());
        assert!(arguments(&["--device-path", "x"]).is_err(), "a path without a joystick is meaningless");
        assert!(arguments(&["--joystick", "044F:B10A", "--button", "1", "--device-path", "bad\npath"]).is_err());
        assert!(arguments(&["--surprise"]).is_err());
    }

    #[test]
    fn encodes_device_and_button_events_as_single_json_lines() {
        let identity = JoystickIdentity {
            path: "\\\\?\\hid#vid_044f&pid_b10a#9&764e407&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}".to_string(),
            vendor_id: 0x044F,
            product_id: 0xB10A,
            name: "T.16000M \"left\"".to_string(),
            buttons: 16,
        };
        let device = String::from_utf8(OutputEvent::Device { identity: identity.clone(), connected: true }.encoded()).unwrap();
        assert_eq!(
            device,
            "{\"type\":\"device\",\"connected\":true,\"vendorId\":\"044F\",\"productId\":\"B10A\",\"name\":\"T.16000M \\\"left\\\"\",\"path\":\"\\\\\\\\?\\\\hid#vid_044f&pid_b10a#9&764e407&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}\",\"buttons\":16}\n",
        );
        let button = String::from_utf8(OutputEvent::Button { identity, button: 5, down: true }.encoded()).unwrap();
        assert!(button.starts_with("{\"type\":\"button\",\"vendorId\":\"044F\""));
        assert!(button.ends_with(",\"buttons\":16,\"button\":5,\"down\":true}\n"));
        assert_eq!(button.matches('\n').count(), 1);
        assert_eq!(json_string("tab\tand\u{1}"), "\"tab\\u0009and\\u0001\"");
    }

    #[test]
    fn product_names_are_trimmed_bounded_and_printable() {
        assert_eq!(clean_product_name("  T.16000M\u{0}\r\n "), Some("T.16000M".to_string()));
        assert_eq!(clean_product_name("\u{7}"), None);
        let long = "x".repeat(100);
        assert_eq!(clean_product_name(&long).map(|name| name.chars().count()), Some(64));
    }

    #[test]
    fn reports_only_the_buttons_that_changed() {
        let mut changes = Vec::new();
        diff_buttons(&[1, 3], &[3, 5], &mut |button, down| changes.push((button, down)));
        assert_eq!(changes, vec![(1, false), (5, true)]);
    }

    #[test]
    fn prefers_the_recorded_path_and_falls_back_to_the_vendor_product_match() {
        let paths = vec![
            "\\\\?\\hid#vid_046d&pid_c216#1#{guid}".to_string(),
            "\\\\?\\HID#VID_044F&PID_B10A#7#{guid}".to_string(),
            "\\\\?\\hid#vid_044f&pid_b10a#9#{guid}".to_string(),
        ];
        let binding = JoystickBinding {
            vendor_id: 0x044F, product_id: 0xB10A, button: 1,
            path: Some("\\\\?\\HID#VID_044F&PID_B10A#9#{GUID}".to_string()),
        };
        assert_eq!(
            binding_candidates(&paths, &binding),
            vec!["\\\\?\\hid#vid_044f&pid_b10a#9#{guid}".to_string(), "\\\\?\\HID#VID_044F&PID_B10A#7#{guid}".to_string()],
        );
        let moved = JoystickBinding { path: Some("\\\\?\\hid#vid_044f&pid_b10a#gone#{guid}".to_string()), ..binding };
        assert_eq!(binding_candidates(&paths, &moved).len(), 2);
        let other = JoystickBinding { vendor_id: 0x0001, product_id: 0x0002, button: 1, path: None };
        assert!(binding_candidates(&paths, &other).is_empty());
    }

    #[test]
    fn press_sources_combine_into_one_hold() {
        // No output channel is installed in tests, so only the bookkeeping is
        // exercised: the transitions that would emit are the ones that change
        // the mask between zero and non-zero.
        PRESSED_SOURCES.store(0, Ordering::SeqCst);
        assert_eq!(PRESSED_SOURCES.fetch_or(super::SOURCE_KEYBOARD, Ordering::SeqCst), 0, "first press emits down");
        assert_ne!(PRESSED_SOURCES.fetch_or(super::SOURCE_JOYSTICK, Ordering::SeqCst), 0, "second source joins silently");
        let after_keyboard = PRESSED_SOURCES.fetch_and(!super::SOURCE_KEYBOARD, Ordering::SeqCst);
        assert_ne!(after_keyboard & !super::SOURCE_KEYBOARD, 0, "releasing one source keeps the hold");
        let after_joystick = PRESSED_SOURCES.fetch_and(!super::SOURCE_JOYSTICK, Ordering::SeqCst);
        assert_eq!(after_joystick & !super::SOURCE_JOYSTICK, 0, "releasing the last source emits up");
    }
}
