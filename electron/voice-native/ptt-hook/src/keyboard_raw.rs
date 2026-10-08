//! Keyboard Raw Input registration and packet decoding. No input is suppressed.
use super::*;
use keyboard::{KeyboardState, Snapshot};
use std::{mem::size_of, ptr};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::{LibraryLoader::GetModuleHandleW, RemoteDesktop::*, SystemInformation::GetTickCount},
    UI::{
        Input::{
            KeyboardAndMouse::{MAPVK_VK_TO_VSC_EX, MapVirtualKeyW},
            *,
        },
        WindowsAndMessaging::*,
    },
};

const WM_KEYBOARD_POWER: u32 = WM_APP + 21;
const WM_KEYBOARD_SESSION: u32 = WM_APP + 22;

#[derive(Debug, PartialEq)]
enum Packet {
    Key { key: u32, down: bool },
    Ignore,
    Reset,
}

fn decode(keyboard: RAWKEYBOARD) -> Result<Packet, Failure> {
    if keyboard.MakeCode == 0xff {
        return Ok(Packet::Reset);
    }
    if keyboard.VKey == 0 || keyboard.VKey >= 255 {
        return Ok(Packet::Ignore);
    }
    let flags = keyboard.Flags as u32;
    if keyboard.Reserved != 0
        || flags
            & !(RI_KEY_BREAK
                | RI_KEY_E0
                | RI_KEY_E1
                | RI_KEY_TERMSRV_SET_LED
                | RI_KEY_TERMSRV_SHADOW)
            != 0
    {
        return Err(Failure::Runtime);
    }
    // Windows can report a legacy key-up without RI_KEY_BREAK for Japanese
    // Hankaku/Zenkaku. Use the virtual-key message for virtual-key state;
    // disagreement with the scan-code flags must not terminate the owner.
    let down = match keyboard.Message {
        WM_KEYDOWN | WM_SYSKEYDOWN => true,
        WM_KEYUP | WM_SYSKEYUP => false,
        _ => return Err(Failure::Runtime),
    };
    let key = match keyboard.VKey {
        0x10 => {
            // Extended fake shifts accompany some legacy multi-key sequences.
            if flags & (RI_KEY_E0 | RI_KEY_E1) != 0 {
                return Ok(Packet::Ignore);
            }
            let scan = if keyboard.MakeCode == 0 {
                unsafe { MapVirtualKeyW(keyboard.VKey as u32, MAPVK_VK_TO_VSC_EX) }
            } else {
                keyboard.MakeCode as u32
            };
            match scan {
                0x2a => VK_LSHIFT,
                0x36 => VK_RSHIFT,
                _ => return Err(Failure::Runtime),
            }
        }
        0x11 => {
            if flags & RI_KEY_E0 != 0 {
                VK_RCONTROL
            } else {
                VK_LCONTROL
            }
        }
        0x12 => {
            if flags & RI_KEY_E0 != 0 {
                VK_RMENU
            } else {
                VK_LMENU
            }
        }
        key => key as u32,
    };
    Ok(Packet::Key { key, down })
}

fn validate_packet(raw: &RAWINPUT, copied: u32) -> Result<Packet, Failure> {
    let expected = size_of::<RAWINPUTHEADER>() + size_of::<RAWKEYBOARD>();
    if copied as usize != expected
        || raw.header.dwSize != copied
        || raw.header.dwType != RIM_TYPEKEYBOARD
    {
        return Err(Failure::Runtime);
    }
    // The validated type and full keyboard payload select the initialized union.
    decode(unsafe { raw.data.keyboard })
}

// Only forward synchronous lifecycle notifications; mutable state and packet
// parsing stay in the message loop, so Rust panics cannot cross this ABI.
unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let forwarded = match message {
        WM_POWERBROADCAST => Some(WM_KEYBOARD_POWER),
        WM_WTSSESSION_CHANGE => Some(WM_KEYBOARD_SESSION),
        _ => None,
    };
    if let Some(message) = forwarded
        && unsafe { PostMessageW(hwnd, message, w, l) } == 0
    {
        unsafe { PostQuitMessage(1) };
    }
    unsafe { DefWindowProcW(hwnd, message, w, l) }
}

struct Window {
    hwnd: HWND,
    class: Vec<u16>,
    registered: bool,
    session_notifications: bool,
}

impl Window {
    fn create(standalone: bool) -> Result<Self, Failure> {
        let class: Vec<u16> = "FlightFabricKeyboardInput"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let module = unsafe { GetModuleHandleW(ptr::null()) };
        let definition = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: module,
            lpszClassName: class.as_ptr(),
            ..Default::default()
        };
        if unsafe { RegisterClassW(&definition) } == 0 {
            return Err(Failure::Startup);
        }
        // A hidden top-level window receives power broadcasts; never show or
        // activate it. Message-only windows would miss those notifications.
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                module,
                ptr::null(),
            )
        };
        let mut window = Self {
            hwnd,
            class,
            registered: false,
            session_notifications: false,
        };
        if hwnd.is_null() {
            return Err(Failure::Startup);
        }
        let registration = RAWINPUTDEVICE {
            usUsagePage: 1,
            usUsage: 6,
            dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
            hwndTarget: hwnd,
        };
        if unsafe { RegisterRawInputDevices(&registration, 1, size_of::<RAWINPUTDEVICE>() as u32) }
            == 0
        {
            return Err(Failure::Startup);
        }
        window.registered = true;
        if standalone {
            if unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } == 0 {
                return Err(Failure::Startup);
            }
            window.session_notifications = true;
        }
        Ok(window)
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        unsafe {
            if self.session_notifications {
                WTSUnRegisterSessionNotification(self.hwnd);
            }
            if self.registered {
                let registration = RAWINPUTDEVICE {
                    usUsagePage: 1,
                    usUsage: 6,
                    dwFlags: RIDEV_REMOVE,
                    hwndTarget: ptr::null_mut(),
                };
                RegisterRawInputDevices(&registration, 1, size_of::<RAWINPUTDEVICE>() as u32);
            }
            if !self.hwnd.is_null() {
                DestroyWindow(self.hwnd);
            }
            UnregisterClassW(self.class.as_ptr(), GetModuleHandleW(ptr::null()));
        }
    }
}

pub(super) struct Input {
    window: Window,
    config: HookConfig,
    state: KeyboardState,
    standalone: bool,
    lifecycle: Lifecycle,
}

#[derive(Default)]
struct Lifecycle {
    session_paused: bool,
    power_paused: bool,
}

#[derive(Debug, PartialEq)]
enum Transition {
    Pause(&'static str),
    Resume,
}

impl Lifecycle {
    fn observe(&mut self, message: &MSG) -> Option<Transition> {
        let was_paused = self.power_paused || self.session_paused;
        let reason = match (message.message, message.wParam as u32) {
            (WM_KEYBOARD_POWER, PBT_APMSUSPEND | PBT_APMSTANDBY) => {
                self.power_paused = true;
                Some("suspend")
            }
            (
                WM_KEYBOARD_SESSION,
                WTS_SESSION_LOCK
                | WTS_SESSION_LOGOFF
                | WTS_CONSOLE_DISCONNECT
                | WTS_REMOTE_DISCONNECT,
            ) => {
                self.session_paused = true;
                Some("session-ended")
            }
            (
                WM_KEYBOARD_POWER,
                PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND | PBT_APMRESUMESTANDBY,
            ) => {
                self.power_paused = false;
                None
            }
            (
                WM_KEYBOARD_SESSION,
                WTS_SESSION_UNLOCK | WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT,
            ) => {
                self.session_paused = false;
                None
            }
            _ => None,
        };
        if let Some(reason) = reason {
            Some(Transition::Pause(reason))
        } else if was_paused && !self.power_paused && !self.session_paused {
            Some(Transition::Resume)
        } else {
            None
        }
    }
}

impl Input {
    pub fn create(config: HookConfig, standalone: bool) -> Result<Self, Failure> {
        let window = Window::create(standalone)?;
        let state = KeyboardState::new(config, Snapshot::read(config), unsafe { GetTickCount() });
        Ok(Self {
            window,
            config,
            state,
            standalone,
            lifecycle: Lifecycle::default(),
        })
    }

    pub fn set_paused(&mut self, paused: bool) {
        let snapshot = if paused {
            Snapshot::default()
        } else {
            Snapshot::read(self.config)
        };
        self.state
            .set_paused(paused, snapshot, unsafe { GetTickCount() });
    }

    fn input(&mut self, handle: HRAWINPUT, time: u32) -> Result<Option<OutputEvent>, Failure> {
        // RAWINPUT provides DWORD alignment and a fixed upper bound. Keyboard
        // packets never require HID-sized buffers or per-event allocation.
        let mut raw = RAWINPUT::default();
        let mut size = size_of::<RAWINPUT>() as u32;
        let copied = unsafe {
            GetRawInputData(
                handle,
                RID_INPUT,
                (&mut raw as *mut RAWINPUT).cast(),
                &mut size,
                size_of::<RAWINPUTHEADER>() as u32,
            )
        };
        if copied == u32::MAX || copied > size_of::<RAWINPUT>() as u32 {
            return Err(Failure::Runtime);
        }
        match validate_packet(&raw, copied)? {
            Packet::Key { key, down } => {
                self.state
                    .observe(raw.header.hDevice as usize, key, down, time)
            }
            Packet::Ignore => Ok(None),
            Packet::Reset => Ok(self.state.reset()),
        }
    }

    pub fn dispatch(&mut self, message: &MSG) -> Result<(), Failure> {
        let result = if message.hwnd == self.window.hwnd {
            match message.message {
                WM_INPUT => self.input(message.lParam as HRAWINPUT, message.time),
                WM_INPUT_DEVICE_CHANGE
                    if matches!(message.wParam as u32, GIDC_ARRIVAL | GIDC_REMOVAL) =>
                {
                    self.state.device_change(
                        message.lParam as usize,
                        message.wParam == GIDC_ARRIVAL as usize,
                        message.time,
                        unsafe { GetTickCount() },
                    )
                }
                _ => Ok(None),
            }
        } else {
            Ok(None)
        };
        // Windows must clean up foreground WM_INPUT even when parsing failed.
        unsafe {
            TranslateMessage(message);
            DispatchMessageW(message);
        }
        if let Some(event) = result? {
            queue_output(event);
        }
        if self.standalone && message.hwnd == self.window.hwnd {
            self.lifecycle(message);
        }
        Ok(())
    }

    fn lifecycle(&mut self, message: &MSG) {
        match self.lifecycle.observe(message) {
            Some(Transition::Pause(reason)) => {
                self.set_paused(true);
                queue_output(OutputEvent::Cancel(reason));
                queue_output(OutputEvent::Paused);
            }
            Some(Transition::Resume) => {
                queue_output(OutputEvent::Resumed);
                self.set_paused(false);
            }
            None => {}
        }
    }
}

pub(super) fn run_standalone(config: HookConfig) -> Result<(), Failure> {
    let mut input = Input::create(config, true)?;
    queue_output(OutputEvent::Ready);
    input.set_paused(false);
    loop {
        let mut message = MSG::default();
        if unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } <= 0 {
            return Err(Failure::Runtime);
        }
        input.dispatch(&message)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(key: u16, scan: u16, flags: u16) -> RAWKEYBOARD {
        RAWKEYBOARD {
            VKey: key,
            MakeCode: scan,
            Flags: flags,
            Message: if flags & RI_KEY_BREAK as u16 != 0 {
                WM_KEYUP
            } else {
                WM_KEYDOWN
            },
            ..Default::default()
        }
    }

    #[test]
    fn standalone_lifecycle_requires_both_power_and_session_resume() {
        let mut lifecycle = Lifecycle::default();
        let message = |kind, value| MSG {
            message: kind,
            wParam: value as usize,
            ..Default::default()
        };
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_SESSION, WTS_SESSION_UNLOCK)),
            None
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_SESSION, WTS_SESSION_LOCK)),
            Some(Transition::Pause("session-ended"))
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_POWER, PBT_APMSUSPEND)),
            Some(Transition::Pause("suspend"))
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_POWER, PBT_APMRESUMEAUTOMATIC)),
            None
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_SESSION, WTS_SESSION_UNLOCK)),
            Some(Transition::Resume)
        );
        assert_eq!(
            lifecycle.observe(&message(WM_KEYBOARD_POWER, PBT_APMRESUMESUSPEND)),
            None
        );
    }

    #[test]
    fn normalizes_left_right_modifiers_and_make_break_flags() {
        for (vk, scan, flags, key) in [
            (0x10, 0x2a, 0, VK_LSHIFT),
            (0x10, 0x36, 0, VK_RSHIFT),
            (0x11, 0x1d, 0, VK_LCONTROL),
            (0x11, 0x1d, 2, VK_RCONTROL),
            (0x12, 0x38, 0, VK_LMENU),
            (0x12, 0x38, 2, VK_RMENU),
        ] {
            assert_eq!(
                decode(packet(vk, scan, flags)).unwrap(),
                Packet::Key { key, down: true }
            );
            assert_eq!(
                decode(packet(vk, scan, flags | 1)).unwrap(),
                Packet::Key { key, down: false }
            );
        }
        assert_eq!(
            decode(packet(0x10, 0, 0)).unwrap(),
            Packet::Key {
                key: VK_LSHIFT,
                down: true
            }
        );
        assert_eq!(
            decode(packet(0x20, 0, 0)).unwrap(),
            Packet::Key {
                key: VK_SPACE,
                down: true
            }
        );
    }

    #[test]
    fn ignores_unmapped_fake_keys_and_cancels_overrun_without_a_release() {
        assert_eq!(decode(packet(255, 0x2a, 0)).unwrap(), Packet::Ignore);
        assert_eq!(decode(packet(0x10, 0x2a, 2)).unwrap(), Packet::Ignore);
        assert_eq!(decode(packet(0, 255, 0)).unwrap(), Packet::Reset);
        let mut invalid = packet(0x20, 0x39, 0);
        invalid.Message = WM_CHAR;
        assert_eq!(decode(invalid), Err(Failure::Runtime));
    }

    #[test]
    fn legacy_ime_release_without_break_flag_does_not_fail_keyboard_input() {
        // Representative Hankaku/Zenkaku packet with the Windows direction
        // mismatch documented in SDL commit dc6f0f0dcc06e9d282e949f19fad97e44468ceef.
        // This is a decoder fixture, not a locally recorded hardware packet.
        let mut release = packet(0xf3, 0x29, 0);
        release.Message = WM_KEYUP;
        assert_eq!(
            decode(release),
            Ok(Packet::Key {
                key: 0xf3,
                down: false,
            })
        );
        // Ordinary PTT input remains decodable after the unrelated IME key.
        assert_eq!(
            decode(packet(0x20, 0x39, 0)),
            Ok(Packet::Key {
                key: VK_SPACE,
                down: true,
            })
        );
    }

    #[test]
    fn rejects_truncated_wrong_type_or_inconsistent_packets_before_union_read() {
        let length = (size_of::<RAWINPUTHEADER>() + size_of::<RAWKEYBOARD>()) as u32;
        let mut raw = RAWINPUT::default();
        raw.header.dwType = RIM_TYPEKEYBOARD;
        raw.header.dwSize = length;
        raw.data.keyboard = packet(0x20, 0x39, 0);
        assert_eq!(
            validate_packet(&raw, length).unwrap(),
            Packet::Key {
                key: VK_SPACE,
                down: true
            }
        );
        assert_eq!(validate_packet(&raw, length - 1), Err(Failure::Runtime));
        raw.header.dwType = RIM_TYPEHID;
        assert_eq!(validate_packet(&raw, length), Err(Failure::Runtime));
        raw.header.dwType = RIM_TYPEKEYBOARD;
        raw.header.dwSize += 1;
        assert_eq!(validate_packet(&raw, length), Err(Failure::Runtime));
    }
}
