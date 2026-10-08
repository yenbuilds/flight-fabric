//! Windows-owned report delivery. No device handles, input-report queries,
//! keyboard hooks/injection, microphone access or simulator communication.
use super::{Options, Output, json_string, reports::*};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    mem::{offset_of, size_of},
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Devices::HumanInterfaceDevice::*,
    Foundation::{ERROR_INSUFFICIENT_BUFFER, GetLastError, HANDLE, HWND, LPARAM, LRESULT, WPARAM},
    System::{LibraryLoader::GetModuleHandleW, RemoteDesktop::*},
    UI::{Input::*, WindowsAndMessaging::*},
};

const MAX_DEVICES: usize = 256;
const MAX_PREPARSED_BYTES: u32 = 1024 * 1024;
// Aggregate discovery limits complement per-device bounds. Live bindings retain
// just their exact device/button; setup must also tolerate many virtual devices.
const MAX_TOTAL_PREPARSED_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_BUTTONS: usize = 16 * 1024;
const WM_PROBE_POWER: u32 = WM_APP + 1;
const WM_PROBE_SESSION: u32 = WM_APP + 2;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);

struct Heartbeat {
    last: Instant,
}

impl Heartbeat {
    fn new(now: Instant) -> Self {
        Self { last: now }
    }

    fn due(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.last) < HEARTBEAT_INTERVAL {
            return false;
        }
        // A delayed iteration emits once, never a burst for missed intervals.
        self.last = now;
        true
    }
}

struct DeviceIdentity {
    path: String,
    vendor: u32,
    product: u32,
}

struct DeviceLoadError {
    path: Option<String>,
    message: String,
}

fn device_error_fields(path: Option<&str>, message: &str) -> String {
    let ownership = match path {
        Some(path) => format!("\"scope\":\"device\",\"path\":{}", json_string(path)),
        None => "\"scope\":\"discovery\"".into(),
    };
    format!(
        "\"type\":\"device-error\",{ownership},\"message\":{}",
        json_string(message)
    )
}

fn os_error(operation: &str) -> String {
    format!("{operation}: {}", std::io::Error::last_os_error())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn controller(usage_page: u16, usage: u16) -> bool {
    usage_page == 1 && matches!(usage, 4 | 5 | 8)
}

fn button_map(caps: &[HIDP_BUTTON_CAPS]) -> Result<ButtonMap, String> {
    let mut map = BTreeMap::new();
    let mut identities = BTreeSet::new();
    for cap in caps {
        if cap.UsagePage != 9 || cap.IsAlias {
            continue;
        }
        if !cap.IsAbsolute {
            return Err("Relative buttons are not supported by this prototype".into());
        }
        // SAFETY: the Windows parser supplies the tagged union; IsRange selects it.
        let (first, last, first_index, last_index) = unsafe {
            if cap.IsRange {
                let range = cap.Anonymous.Range;
                (
                    range.UsageMin,
                    range.UsageMax,
                    range.DataIndexMin,
                    range.DataIndexMax,
                )
            } else {
                let single = cap.Anonymous.NotRange;
                (
                    single.Usage,
                    single.Usage,
                    single.DataIndex,
                    single.DataIndex,
                )
            }
        };
        if first == 0
            || last < first
            || last_index < first_index
            || last - first != last_index - first_index
            || map.len() + usize::from(last - first) + 1 > MAX_BUTTONS
        {
            return Err("Unsupported or excessive HID button capability range".into());
        }
        for delta in 0..=last - first {
            let button = Button {
                report_id: cap.ReportID,
                collection: cap.LinkCollection,
                usage: first + delta,
            };
            if map.insert(first_index + delta, button).is_some() || !identities.insert(button) {
                return Err("Ambiguous HID button identity; no button was selected".into());
            }
        }
    }
    Ok(map)
}

struct Device {
    path: String,
    name: String,
    vendor: u32,
    product: u32,
    // u64 storage satisfies alignment requirements and stays alive during all
    // HidP calls. This is a copied Windows blob, not a HidD-owned allocation.
    preparsed: Vec<u64>,
    report_length: usize,
    button_count: usize,
    map: ButtonMap,
    data: Vec<HIDP_DATA>,
    holds: Holds,
}

impl Device {
    fn fields(&self) -> String {
        format!(
            "\"path\":{},\"name\":{},\"vendorId\":\"{:04X}\",\"productId\":\"{:04X}\",\"buttons\":{}",
            json_string(&self.path),
            json_string(&self.name),
            self.vendor,
            self.product,
            self.button_count
        )
    }

    fn load(handle: HANDLE, selected: Option<&str>) -> Result<Option<Self>, DeviceLoadError> {
        let Some(identity) =
            Self::identity(handle, selected).map_err(|message| DeviceLoadError {
                path: None,
                message,
            })?
        else {
            return Ok(None);
        };
        Self::load_descriptor(handle, &identity).map_err(|message| DeviceLoadError {
            path: Some(identity.path),
            message,
        })
    }

    fn identity(handle: HANDLE, selected: Option<&str>) -> Result<Option<DeviceIdentity>, String> {
        let mut info = RID_DEVICE_INFO {
            cbSize: size_of::<RID_DEVICE_INFO>() as u32,
            ..Default::default()
        };
        let mut size = info.cbSize;
        // SAFETY: writable POD and its exact size are passed to Windows.
        if unsafe {
            GetRawInputDeviceInfoW(
                handle,
                RIDI_DEVICEINFO,
                (&mut info as *mut RID_DEVICE_INFO).cast(),
                &mut size,
            )
        } == u32::MAX
        {
            return Err(os_error("Read controller information"));
        }
        if info.dwType != RIM_TYPEHID {
            return Ok(None);
        }
        // SAFETY: dwType selected the HID member.
        let hid = unsafe { info.Anonymous.hid };
        if !controller(hid.usUsagePage, hid.usUsage) {
            return Ok(None);
        }
        let mut chars = 0;
        if unsafe { GetRawInputDeviceInfoW(handle, RIDI_DEVICENAME, ptr::null_mut(), &mut chars) }
            == u32::MAX
        {
            return Err(os_error("Read controller path length"));
        }
        if chars == 0 || chars > 4096 {
            return Err("Controller path exceeds diagnostic limit".into());
        }
        let mut path = vec![0_u16; chars as usize];
        let copied = unsafe {
            GetRawInputDeviceInfoW(
                handle,
                RIDI_DEVICENAME,
                path.as_mut_ptr().cast(),
                &mut chars,
            )
        };
        if copied == u32::MAX || copied as usize > path.len() {
            return Err(os_error("Read controller path"));
        }
        let end = path.iter().position(|c| *c == 0).unwrap_or(copied as usize);
        let path =
            String::from_utf16(&path[..end]).map_err(|_| "Invalid controller path encoding")?;
        if path.is_empty() || path.chars().any(char::is_control) {
            return Err("Invalid controller path".into());
        }
        if selected.is_some_and(|saved| !saved.eq_ignore_ascii_case(&path)) {
            return Ok(None);
        }
        Ok(Some(DeviceIdentity {
            path,
            vendor: hid.dwVendorId,
            product: hid.dwProductId,
        }))
    }

    fn load_descriptor(handle: HANDLE, identity: &DeviceIdentity) -> Result<Option<Self>, String> {
        let mut bytes = 0;
        if unsafe {
            GetRawInputDeviceInfoW(handle, RIDI_PREPARSEDDATA, ptr::null_mut(), &mut bytes)
        } == u32::MAX
        {
            return Err(os_error("Read HID descriptor size"));
        }
        if bytes == 0 || bytes > MAX_PREPARSED_BYTES {
            return Err("HID descriptor exceeds diagnostic limit".into());
        }
        let mut preparsed = vec![0_u64; (bytes as usize).div_ceil(8)];
        let copied = unsafe {
            GetRawInputDeviceInfoW(
                handle,
                RIDI_PREPARSEDDATA,
                preparsed.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if copied == u32::MAX || copied == 0 || copied as usize > preparsed.len() * 8 {
            return Err(os_error("Read HID descriptor"));
        }
        let preparsed_ptr = preparsed.as_ptr() as PHIDP_PREPARSED_DATA;
        let mut caps = HIDP_CAPS::default();
        if unsafe { HidP_GetCaps(preparsed_ptr, &mut caps) } != HIDP_STATUS_SUCCESS {
            return Err("Windows could not parse the HID descriptor".into());
        }
        if !controller(caps.UsagePage, caps.Usage)
            || caps.InputReportByteLength == 0
            || usize::from(caps.NumberInputButtonCaps) > MAX_BUTTONS
        {
            return Err("Unsupported controller report capabilities".into());
        }
        if caps.NumberInputButtonCaps == 0 {
            return Ok(None);
        }
        let mut count = caps.NumberInputButtonCaps;
        let mut buttons = vec![HIDP_BUTTON_CAPS::default(); usize::from(count)];
        if unsafe {
            HidP_GetButtonCaps(HidP_Input, buttons.as_mut_ptr(), &mut count, preparsed_ptr)
        } != HIDP_STATUS_SUCCESS
            || usize::from(count) > buttons.len()
        {
            return Err("Windows could not parse HID button capabilities".into());
        }
        let map = button_map(&buttons[..usize::from(count)])?;
        if map.is_empty() {
            return Ok(None);
        }
        let data_length = unsafe { HidP_MaxDataListLength(HidP_Input, preparsed_ptr) } as usize;
        if data_length == 0 || data_length > 8192 {
            return Err("HID data list exceeds diagnostic limit".into());
        }
        Ok(Some(Self {
            name: super::names::controller_name(&identity.path).unwrap_or_default(),
            path: identity.path.clone(),
            vendor: identity.vendor,
            product: identity.product,
            preparsed,
            report_length: usize::from(caps.InputReportByteLength),
            button_count: map.len(),
            map,
            data: vec![HIDP_DATA::default(); data_length],
            holds: Holds::default(),
        }))
    }

    fn report(&mut self, report: &[u8]) -> Result<Vec<Transition>, String> {
        if report.len() != self.report_length {
            return Err("HID report length does not match its descriptor".into());
        }
        let report_id = report[0];
        if !self
            .map
            .values()
            .any(|button| button.report_id == report_id)
        {
            return Ok(Vec::new()); // No button state in this report; do not release anything.
        }
        let mut count = self.data.len() as u32;
        // SAFETY: all buffers are owned, bounded, aligned and sized for this
        // descriptor. HidP owns interpretation of the device's report format.
        let status = unsafe {
            HidP_GetData(
                HidP_Input,
                self.data.as_mut_ptr(),
                &mut count,
                self.preparsed.as_ptr() as PHIDP_PREPARSED_DATA,
                // HidP_GetData declares Report as [in]; the mutable pointer in
                // the C signature does not imply a write. The slice stays live.
                report.as_ptr().cast_mut(),
                report.len() as u32,
            )
        };
        if status != HIDP_STATUS_SUCCESS || count as usize > self.data.len() {
            return Err(format!("Windows rejected the HID report ({status:#x})"));
        }
        let pressed = pressed_buttons(
            &self.map,
            report_id,
            self.data[..count as usize].iter().map(|data| {
                // Only read On for known buttons; values occupy the other union member.
                let on = self.map.contains_key(&data.DataIndex) && unsafe { data.Anonymous.On };
                (data.DataIndex, on)
            }),
        )?;
        Ok(self.holds.observe(report_id, pressed))
    }
}

fn button_fields(kind: &str, button: Button) -> String {
    format!(
        "\"type\":\"{kind}\",\"reportId\":{},\"linkCollection\":{},\"button\":{}",
        button.report_id, button.collection, button.usage
    )
}

fn enumerate() -> Result<Vec<RAWINPUTDEVICELIST>, String> {
    // Arrival/removal can race enumeration. Retry a bounded number of times.
    for _ in 0..3 {
        let mut count = 0;
        if unsafe {
            GetRawInputDeviceList(
                ptr::null_mut(),
                &mut count,
                size_of::<RAWINPUTDEVICELIST>() as u32,
            )
        } == u32::MAX
        {
            return Err(os_error("Enumerate input device count"));
        }
        if count as usize > MAX_DEVICES {
            return Err("Device count exceeds diagnostic limit".into());
        }
        if count == 0 {
            return Ok(Vec::new());
        }
        let mut devices = vec![RAWINPUTDEVICELIST::default(); count as usize];
        let result = unsafe {
            GetRawInputDeviceList(
                devices.as_mut_ptr(),
                &mut count,
                size_of::<RAWINPUTDEVICELIST>() as u32,
            )
        };
        if result != u32::MAX && result as usize <= devices.len() {
            devices.truncate(result as usize);
            return Ok(devices);
        }
        if unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(os_error("Enumerate input devices"));
        }
    }
    Err("Controller list kept changing; try the diagnostic again".into())
}

fn within_discovery_budget(
    descriptors: usize,
    buttons: usize,
    new_bytes: usize,
    new_buttons: usize,
) -> bool {
    descriptors
        .checked_add(new_bytes)
        .is_some_and(|total| total <= MAX_TOTAL_PREPARSED_BYTES)
        && buttons
            .checked_add(new_buttons)
            .is_some_and(|total| total <= MAX_TOTAL_BUTTONS)
}

fn prepare_packet(buffer: &mut Vec<u64>, bytes: usize) -> Result<(), String> {
    if !(size_of::<RAWINPUTHEADER>()..=MAX_PACKET_BYTES).contains(&bytes) {
        return Err("Raw Input packet exceeds input limits".into());
    }
    let words = bytes.div_ceil(8);
    if words > buffer.len() {
        buffer
            .try_reserve_exact(words - buffer.len())
            .map_err(|_| "Unable to allocate Raw Input packet")?;
        buffer.resize(words, 0);
    }
    Ok(())
}

struct Controllers<'a> {
    devices: HashMap<usize, Device>,
    packet: Vec<u64>,
    selected: Option<String>,
    button: Option<Button>,
    output: &'a mut dyn Output,
}

impl Controllers<'_> {
    fn arrive(&mut self, handle: HANDLE) -> Result<(), String> {
        if self.devices.contains_key(&(handle as usize)) {
            return Ok(());
        }
        if self.devices.len() >= MAX_DEVICES {
            return Err("Controller count exceeds diagnostic limit".into());
        }
        match Device::load(handle, self.selected.as_deref()) {
            Ok(Some(mut device)) => {
                if self
                    .button
                    .is_some_and(|button| !device.map.values().any(|value| *value == button))
                {
                    self.output.emit(&device_error_fields(
                        Some(&device.path),
                        "Saved controller button is unavailable; select it again",
                    ))?;
                    return Ok(());
                }
                if let Some(selected) = self.button {
                    // The descriptor has already been validated in full. Keep
                    // only the selected button's state in continuous monitoring.
                    device.map.retain(|_, button| *button == selected);
                }
                let descriptors = self
                    .devices
                    .values()
                    .map(|d| d.preparsed.len() * 8)
                    .sum::<usize>();
                let buttons = self.devices.values().map(|d| d.map.len()).sum::<usize>();
                if !within_discovery_budget(
                    descriptors,
                    buttons,
                    device.preparsed.len() * 8,
                    device.map.len(),
                ) {
                    return Err("Controller discovery memory limit reached".into());
                }
                self.output.emit(&format!(
                    "\"type\":\"device\",\"connected\":true,{}",
                    device.fields()
                ))?;
                self.devices.insert(handle as usize, device);
            }
            Ok(None) => {}
            Err(error) => self
                .output
                .emit(&device_error_fields(error.path.as_deref(), &error.message))?,
        }
        Ok(())
    }

    fn remove(&mut self, handle: HANDLE, reason: &str) -> Result<(), String> {
        if let Some(mut device) = self.devices.remove(&(handle as usize)) {
            device.holds.cancel();
            self.output.emit(&format!(
                "\"type\":\"cancel\",\"reason\":{},\"path\":{}",
                json_string(reason),
                json_string(&device.path)
            ))?;
            if reason == "device-removed" {
                self.output.emit(&format!(
                    "\"type\":\"device\",\"connected\":false,{}",
                    device.fields()
                ))?;
            }
        }
        Ok(())
    }

    fn quarantine(&mut self, handle: HANDLE, message: &str) -> Result<(), String> {
        // Capture ownership before removal drops the tracked device. An
        // untracked handle cannot fail some other device's active capture.
        let Some(path) = self
            .devices
            .get(&(handle as usize))
            .map(|device| device.path.clone())
        else {
            return Ok(());
        };
        self.remove(handle, "invalid-report")?;
        self.output.emit(&device_error_fields(Some(&path), message))
    }

    fn input(&mut self, input: HRAWINPUT) -> Result<(), String> {
        let header_size = size_of::<RAWINPUTHEADER>() as u32;
        let mut header = RAWINPUTHEADER::default();
        let mut bytes = header_size;
        // Read only the fixed header first. Axis traffic from other controllers
        // and quarantined devices needs neither a packet allocation nor a copy.
        let copied = unsafe {
            GetRawInputData(
                input,
                RID_HEADER,
                (&mut header as *mut RAWINPUTHEADER).cast(),
                &mut bytes,
                header_size,
            )
        };
        if copied != header_size {
            return Err(os_error("Read Raw Input header"));
        }
        if header.dwType != RIM_TYPEHID || !self.devices.contains_key(&(header.hDevice as usize)) {
            return Ok(());
        }
        prepare_packet(&mut self.packet, header.dwSize as usize)?;
        bytes = header.dwSize;
        let copied = unsafe {
            GetRawInputData(
                input,
                RID_INPUT,
                self.packet.as_mut_ptr().cast(),
                &mut bytes,
                header_size,
            )
        };
        if copied != header.dwSize {
            return Err(os_error("Read Raw Input packet"));
        }
        // SAFETY: owned, aligned buffer has at least a complete header. Do not
        // cast it to RAWINPUT: short HID reports can be smaller than that union.
        let copied_header = unsafe { ptr::read(self.packet.as_ptr().cast::<RAWINPUTHEADER>()) };
        if copied_header.dwSize != copied
            || copied_header.dwType != header.dwType
            || copied_header.hDevice != header.hDevice
        {
            return Err("Raw Input header changed while reading its packet".into());
        }
        let Some(device) = self.devices.get_mut(&(header.hDevice as usize)) else {
            return Ok(());
        };
        // The packet is discarded after synchronous parsing; no pointer escapes.
        let packet = unsafe {
            std::slice::from_raw_parts(self.packet.as_ptr().cast::<u8>(), copied as usize)
        };
        let payload = packet
            .get(offset_of!(RAWINPUT, data)..)
            .ok_or("Truncated HID packet")?;
        for report in split_reports(payload)? {
            match device.report(report) {
                Ok(transitions) => {
                    for transition in transitions {
                        if let Some(selected) = self.button {
                            let relevant = match &transition {
                                Transition::Press(button) | Transition::Release(button) => {
                                    *button == selected
                                }
                                Transition::Baseline { report_id, .. } => {
                                    *report_id == selected.report_id
                                }
                            };
                            if !relevant {
                                continue;
                            }
                        }
                        let fields = match transition {
                            Transition::Baseline { report_id, held } => {
                                let held = self.button.map_or(held, |button| {
                                    usize::from(device.holds.is_pressed(button))
                                });
                                format!(
                                    "\"type\":\"baseline\",\"reportId\":{report_id},\"heldButtons\":{held}"
                                )
                            }
                            Transition::Press(button) => button_fields("press", button),
                            Transition::Release(button) => button_fields("release", button),
                        };
                        // Output failure stops the entire run. It must never be
                        // mistaken for a recoverable device/descriptor error.
                        self.output
                            .emit(&format!("{fields},\"path\":{}", json_string(&device.path)))?;
                    }
                }
                Err(error) => {
                    // Quarantine until an explicit new arrival/run; never infer a
                    // release or retry a broken parser for every axis report.
                    self.quarantine(header.hDevice, &error)?;
                    break;
                }
            }
        }
        Ok(())
    }

    fn cancel_all(&mut self, reason: &str) -> Result<(), String> {
        for device in self.devices.values_mut() {
            device.holds.cancel();
        }
        self.output.emit(&format!(
            "\"type\":\"cancel\",\"reason\":{}",
            json_string(reason)
        ))
    }
}

// WndProc only forwards synchronous lifecycle messages. Parsing and mutable
// state live in the ordinary message loop, so Rust panics never cross the ABI.
unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let forward = match message {
        WM_POWERBROADCAST => Some(WM_PROBE_POWER),
        WM_WTSSESSION_CHANGE => Some(WM_PROBE_SESSION),
        _ => None,
    };
    if let Some(message) = forward
        && unsafe { PostMessageW(hwnd, message, w, l) } == 0
    {
        // No safe continuation if lifecycle cancellation cannot be delivered.
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
    fn create(seconds: u32) -> Result<Self, String> {
        let class = wide("FlightFabricControllerDiagnostic");
        let module = unsafe { GetModuleHandleW(ptr::null()) };
        let definition = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: module,
            lpszClassName: class.as_ptr(),
            ..Default::default()
        };
        if unsafe { RegisterClassW(&definition) } == 0 {
            return Err(os_error("Register diagnostic window"));
        }
        // Hidden top-level window receives power broadcasts; it is never shown
        // or activated. A message-only window would miss those broadcasts.
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
            return Err(os_error("Create diagnostic window"));
        }
        let registrations = [4, 5, 8].map(|usage| RAWINPUTDEVICE {
            usUsagePage: 1,
            usUsage: usage,
            dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
            hwndTarget: hwnd,
        });
        if unsafe {
            RegisterRawInputDevices(
                registrations.as_ptr(),
                3,
                size_of::<RAWINPUTDEVICE>() as u32,
            )
        } == 0
        {
            return Err(os_error("Register background controller input"));
        }
        window.registered = true;
        if unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } == 0 {
            return Err(os_error("Register session notifications"));
        }
        window.session_notifications = true;
        if unsafe { SetTimer(hwnd, 1, seconds * 1000, None) } == 0 {
            return Err(os_error("Set diagnostic deadline"));
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
                let registrations = [4, 5, 8].map(|usage| RAWINPUTDEVICE {
                    usUsagePage: 1,
                    usUsage: usage,
                    dwFlags: RIDEV_REMOVE,
                    hwndTarget: ptr::null_mut(),
                });
                RegisterRawInputDevices(
                    registrations.as_ptr(),
                    3,
                    size_of::<RAWINPUTDEVICE>() as u32,
                );
            }
            if !self.hwnd.is_null() {
                KillTimer(self.hwnd, 1);
                DestroyWindow(self.hwnd);
            }
            UnregisterClassW(self.class.as_ptr(), GetModuleHandleW(ptr::null()));
        }
    }
}

pub fn run(mut options: Options, output: &mut dyn Output) -> Result<(), String> {
    let window = if options.continuous {
        Some(Window::create(1)?)
    } else {
        options.seconds.map(Window::create).transpose()?
    };
    let mut controllers = Controllers {
        devices: HashMap::new(),
        packet: Vec::new(),
        selected: options.device_path,
        button: options.button,
        output,
    };
    for device in enumerate()? {
        if device.dwType == RIM_TYPEHID {
            controllers.arrive(device.hDevice)?;
        }
    }
    controllers.output.emit(&format!(
        "\"type\":\"ready\",\"mode\":{},\"controllers\":{}",
        json_string(if window.is_some() { "watch" } else { "list" }),
        controllers.devices.len()
    ))?;
    // Readiness must reach the common output queue before the keyboard owner
    // enables fresh presses. It has kept pumping while discovery ran here.
    (options.on_pause)(false)?;
    let Some(window) = window else {
        controllers
            .output
            .emit("\"type\":\"stopped\",\"reason\":\"listed\"")?;
        return Ok(());
    };
    let deadline = options
        .seconds
        .map(|seconds| Instant::now() + Duration::from_secs(u64::from(seconds)));
    let mut session_paused = false;
    let mut power_paused = false;
    let mut heartbeat = Heartbeat::new(Instant::now());
    let result = (|| -> Result<&str, String> {
        loop {
            let mut message = MSG::default();
            let result = unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) };
            if result == -1 {
                return Err(os_error("Read controller message"));
            }
            if result == 0 {
                return Err("Diagnostic message loop stopped unexpectedly".into());
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                // Even the final foreground WM_INPUT requires Windows cleanup.
                unsafe {
                    DispatchMessageW(&message);
                }
                return Ok("timeout");
            }
            let was_paused = session_paused || power_paused;
            let handled = match message.message {
                WM_INPUT if !session_paused && !power_paused => {
                    controllers.input(message.lParam as HRAWINPUT)
                }
                WM_INPUT_DEVICE_CHANGE
                    if !session_paused
                        && !power_paused
                        && message.wParam == GIDC_ARRIVAL as usize =>
                {
                    controllers.arrive(message.lParam as HANDLE)
                }
                WM_INPUT_DEVICE_CHANGE if message.wParam == GIDC_REMOVAL as usize => {
                    controllers.remove(message.lParam as HANDLE, "device-removed")
                }
                WM_TIMER if message.hwnd == window.hwnd && message.wParam == 1 => {
                    if !options.continuous {
                        return Ok("timeout");
                    }
                    // Idle wake-up only. Busy input must not rely on the low
                    // priority WM_TIMER message to demonstrate loop progress.
                    Ok(())
                }
                WM_PROBE_POWER
                    if matches!(message.wParam as u32, PBT_APMSUSPEND | PBT_APMSTANDBY) =>
                {
                    if !options.continuous {
                        return Ok("suspend");
                    }
                    power_paused = true;
                    (options.on_pause)(true)?;
                    controllers.cancel_all("suspend")?;
                    controllers.devices.clear();
                    controllers.output.emit("\"type\":\"paused\"")
                }
                WM_PROBE_SESSION
                    if matches!(
                        message.wParam as u32,
                        WTS_SESSION_LOCK
                            | WTS_SESSION_LOGOFF
                            | WTS_CONSOLE_DISCONNECT
                            | WTS_REMOTE_DISCONNECT
                    ) =>
                {
                    if !options.continuous {
                        return Ok("session-ended");
                    }
                    session_paused = true;
                    (options.on_pause)(true)?;
                    controllers.cancel_all("session-ended")?;
                    controllers.devices.clear();
                    controllers.output.emit("\"type\":\"paused\"")
                }
                WM_PROBE_POWER
                    if options.continuous
                        && matches!(
                            message.wParam as u32,
                            PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND | PBT_APMRESUMESTANDBY
                        ) =>
                {
                    power_paused = false;
                    Ok(())
                }
                WM_PROBE_SESSION
                    if options.continuous
                        && matches!(
                            message.wParam as u32,
                            WTS_SESSION_UNLOCK | WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT
                        ) =>
                {
                    session_paused = false;
                    Ok(())
                }
                _ => Ok(()),
            };
            // DefWindowProc must see foreground WM_INPUT for Windows cleanup,
            // including when parsing failed. Dispatch before propagating errors.
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            handled?;
            if was_paused && !session_paused && !power_paused {
                for device in enumerate()? {
                    if device.dwType == RIM_TYPEHID {
                        controllers.arrive(device.hDevice)?;
                    }
                }
                controllers.output.emit("\"type\":\"resumed\"")?;
                (options.on_pause)(false)?;
            }
            if options.continuous && heartbeat.due(Instant::now()) {
                controllers.output.emit("\"type\":\"heartbeat\"")?;
            }
        }
    })();
    // Stop keyboard transitions before cancellation enters the shared queue.
    // No callback can append a stale Down after this acknowledged boundary.
    let paused = (options.on_pause)(true);
    let cancelled = controllers.cancel_all(result.as_ref().map_or("error", |reason| *reason));
    drop(window); // Release registrations before announcing completion.
    // Cleanup failure must not replace the original input-loop failure.
    let reason = result?;
    paused?;
    cancelled?;
    controllers.output.emit(&format!(
        "\"type\":\"stopped\",\"reason\":{}",
        json_string(reason)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_input_progress_emits_rate_limited_heartbeats_without_timer_delivery() {
        let start = Instant::now();
        let mut heartbeat = Heartbeat::new(start);
        let emitted: Vec<_> = (0..=6000)
            .filter(|millis| heartbeat.due(start + Duration::from_millis(*millis)))
            .collect();
        assert_eq!(emitted, [1000, 2000, 3000, 4000, 5000, 6000]);
        // After a delayed/suspended loop, the first completed iteration emits
        // once. Subsequent busy iterations cannot flood the bounded output.
        assert!(heartbeat.due(start + Duration::from_secs(60)));
        assert!(!heartbeat.due(start + Duration::from_secs(60)));
        assert!(!heartbeat.due(start + Duration::from_millis(60_999)));
        assert!(heartbeat.due(start + Duration::from_secs(61)));
    }

    #[derive(Default)]
    struct CapturedOutput(Vec<String>);

    impl Output for CapturedOutput {
        fn emit(&mut self, fields: &str) -> Result<(), String> {
            self.0.push(fields.into());
            Ok(())
        }
    }

    fn held_device(path: &str) -> Device {
        let button = Button {
            report_id: 0,
            collection: 0,
            usage: 1,
        };
        let mut holds = Holds::default();
        holds.observe(0, BTreeSet::new());
        holds.observe(0, BTreeSet::from([button]));
        Device {
            path: path.into(),
            name: String::new(),
            vendor: 0,
            product: 0,
            preparsed: Vec::new(),
            report_length: 1,
            button_count: 1,
            map: BTreeMap::from([(0, button)]),
            data: Vec::new(),
            holds,
        }
    }

    #[test]
    fn unknown_handle_discovery_failure_preserves_the_owned_held_device() {
        let mut output = CapturedOutput::default();
        let mut controllers = Controllers {
            devices: HashMap::from([(1, held_device("selected-controller"))]),
            packet: Vec::new(),
            selected: Some("selected-controller".into()),
            button: None,
            output: &mut output,
        };
        // An invalid/new handle models a device disappearing during discovery;
        // it has no trusted identity and cannot own the tracked held button.
        controllers.arrive(ptr::null_mut()).unwrap();
        assert_eq!(controllers.devices.len(), 1);
        assert!(controllers.devices[&1].holds.is_pressed(Button {
            report_id: 0,
            collection: 0,
            usage: 1,
        }));
        drop(controllers);
        assert_eq!(output.0.len(), 1);
        assert!(output.0[0].contains("\"scope\":\"discovery\""));
        assert!(!output.0[0].contains("\"path\""));
        assert!(!output.0[0].contains("\"type\":\"cancel\""));
    }

    #[test]
    fn report_failure_cancels_and_quarantines_only_its_tracked_owner() {
        let mut output = CapturedOutput::default();
        let mut controllers = Controllers {
            devices: HashMap::from([
                (1, held_device("selected-controller")),
                (2, held_device("other-controller")),
            ]),
            packet: Vec::new(),
            selected: None,
            button: None,
            output: &mut output,
        };
        controllers
            .quarantine(1_usize as HANDLE, "Invalid report")
            .unwrap();
        assert!(!controllers.devices.contains_key(&1));
        assert!(controllers.devices[&2].holds.is_pressed(Button {
            report_id: 0,
            collection: 0,
            usage: 1,
        }));
        // Repeated input on the retired handle cannot emit another cancellation.
        controllers
            .quarantine(1_usize as HANDLE, "Invalid report")
            .unwrap();
        drop(controllers);
        assert_eq!(
            output.0,
            [
                "\"type\":\"cancel\",\"reason\":\"invalid-report\",\"path\":\"selected-controller\"",
                "\"type\":\"device-error\",\"scope\":\"device\",\"path\":\"selected-controller\",\"message\":\"Invalid report\"",
            ]
        );
    }

    #[test]
    fn discovery_budget_bounds_combined_devices_and_rejects_overflow() {
        assert!(within_discovery_budget(
            MAX_TOTAL_PREPARSED_BYTES - 8,
            MAX_TOTAL_BUTTONS - 1,
            8,
            1
        ));
        assert!(!within_discovery_budget(
            MAX_TOTAL_PREPARSED_BYTES - 8,
            0,
            16,
            1
        ));
        assert!(!within_discovery_budget(0, MAX_TOTAL_BUTTONS, 8, 1));
        assert!(!within_discovery_budget(usize::MAX, 0, 8, 1));
        assert!(!within_discovery_budget(0, usize::MAX, 8, 1));
        // One removed device frees its descriptor/button allowance immediately.
        assert!(within_discovery_budget(
            MAX_TOTAL_PREPARSED_BYTES - 1024,
            MAX_TOTAL_BUTTONS - 16,
            1024,
            16
        ));
    }

    #[test]
    fn input_buffer_rejects_untrusted_lengths_and_reuses_bounded_storage() {
        let mut buffer = Vec::new();
        for bytes in [
            0,
            size_of::<RAWINPUTHEADER>() - 1,
            MAX_PACKET_BYTES + 1,
            usize::MAX,
        ] {
            assert!(prepare_packet(&mut buffer, bytes).is_err());
            assert_eq!(buffer.capacity(), 0, "invalid sizes must not allocate");
        }
        prepare_packet(&mut buffer, MAX_PACKET_BYTES).unwrap();
        let pointer = buffer.as_ptr();
        let capacity = buffer.capacity();
        for index in 0..100_000 {
            prepare_packet(&mut buffer, size_of::<RAWINPUTHEADER>() + index % 1024).unwrap();
        }
        assert_eq!(buffer.as_ptr(), pointer, "steady input must not reallocate");
        assert_eq!(buffer.capacity(), capacity);
        assert_eq!(buffer.len() * 8, MAX_PACKET_BYTES);
    }

    fn range(report: u8, collection: u16, usage: u16, index: u16, count: u16) -> HIDP_BUTTON_CAPS {
        HIDP_BUTTON_CAPS {
            UsagePage: 9,
            ReportID: report,
            LinkCollection: collection,
            IsRange: true,
            IsAbsolute: true,
            Anonymous: HIDP_BUTTON_CAPS_0 {
                Range: HIDP_BUTTON_CAPS_0_0 {
                    UsageMin: usage,
                    UsageMax: usage + count - 1,
                    DataIndexMin: index,
                    DataIndexMax: index + count - 1,
                    ..Default::default()
                },
            },
            ..Default::default()
        }
    }

    #[test]
    fn descriptor_mapping_handles_large_ranges_and_separate_collections() {
        let map = button_map(&[range(1, 0, 1, 0, 400), range(2, 3, 1, 400, 4)]).unwrap();
        assert_eq!(map.len(), 404);
        assert_eq!(
            map[&399],
            Button {
                report_id: 1,
                collection: 0,
                usage: 400
            }
        );
        assert_eq!(
            map[&400],
            Button {
                report_id: 2,
                collection: 3,
                usage: 1
            }
        );
    }

    #[test]
    fn refuses_ambiguous_or_unsupported_descriptor_mappings() {
        assert!(button_map(&[range(1, 0, 1, 0, 2), range(2, 0, 1, 0, 2)]).is_err());
        assert!(button_map(&[range(1, 0, 1, 0, 2), range(1, 0, 1, 2, 2)]).is_err());
        assert!(button_map(&[range(1, 0, 1, 0, 4097)]).is_err());
        let mut relative = range(1, 0, 1, 0, 1);
        relative.IsAbsolute = false;
        assert!(button_map(&[relative]).is_err());
        let mut malformed = range(1, 0, 1, 0, 2);
        malformed.Anonymous.Range.DataIndexMax = 8;
        assert!(button_map(&[malformed]).is_err());
    }

    #[test]
    fn only_standard_controller_collections_are_eligible() {
        for usage in [4, 5, 8] {
            assert!(controller(1, usage));
        }
        for (page, usage) in [(1, 2), (1, 6), (12, 1), (0xff00, 4)] {
            assert!(!controller(page, usage));
        }
    }
}
