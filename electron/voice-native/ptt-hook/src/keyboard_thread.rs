//! The keyboard Raw Input pump never runs controller discovery or HID parsing.
//! Only its owner mutates keyboard state or removes the registration.
use super::*;
use std::ptr;
use std::{panic::catch_unwind, time::Duration};
use windows_sys::Win32::{
    System::Threading::GetCurrentThreadId,
    UI::WindowsAndMessaging::{GetMessageW, MSG, PostThreadMessageW},
};

const WM_KEYBOARD_CONTROL: u32 = 0x8000 + 20;
// Lifecycle waits are on the controller thread, never in keyboard processing.
// A failed owner must terminate the helper rather than leave stale input state.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug)]
enum Command {
    Pause {
        paused: bool,
        acknowledged: SyncSender<()>,
    },
    Stop,
}

#[derive(Clone)]
pub(super) struct Control {
    thread_id: u32,
    sender: SyncSender<Command>,
}

impl Control {
    fn post(&self, command: Command) -> Result<(), Failure> {
        self.sender
            .try_send(command)
            .map_err(|_| Failure::Runtime)?;
        if unsafe { PostThreadMessageW(self.thread_id, WM_KEYBOARD_CONTROL, 0, 0) } == 0 {
            return Err(Failure::Runtime);
        }
        Ok(())
    }

    pub fn set_paused(&self, paused: bool) -> Result<(), Failure> {
        let (acknowledged, reply) = sync_channel(1);
        self.post(Command::Pause {
            paused,
            acknowledged,
        })?;
        reply
            .recv_timeout(CONTROL_TIMEOUT)
            .map_err(|_| Failure::Runtime)
    }
}

pub(super) struct KeyboardThread {
    control: Control,
    completed: Receiver<()>,
    stopped: bool,
}

impl KeyboardThread {
    pub fn start(config: HookConfig) -> Result<Self, Failure> {
        let (commands, receiver) = sync_channel(1);
        let (ready, startup) = sync_channel(1);
        let (completed, completion) = sync_channel(1);
        let worker = thread::Builder::new()
            .name("ptt-keyboard".into())
            .spawn(move || {
                let result =
                    catch_unwind(|| run(config, receiver, &ready)).unwrap_or(Err(Failure::Runtime));
                if let Err(failure) = result {
                    // A dead message pump cannot be kept healthy by controller
                    // heartbeats. Exit the owned helper; never silently lose PTT.
                    let _ = ready.try_send(Err(failure));
                    queue_output(OutputEvent::Stopped(failure));
                    std::process::exit(failure as i32);
                }
                let _ = completed.try_send(());
            })
            .map_err(|_| Failure::Startup)?;
        // Completion is acknowledged only after registration removal. Detach
        // the JoinHandle: shutdown never gains an unbounded thread.join().
        drop(worker);
        let thread_id = startup
            .recv_timeout(CONTROL_TIMEOUT)
            .map_err(|_| Failure::Startup)??;
        Ok(Self {
            control: Control {
                thread_id,
                sender: commands,
            },
            completed: completion,
            stopped: false,
        })
    }

    pub fn control(&self) -> Control {
        self.control.clone()
    }

    pub fn stop(&mut self) -> Result<(), Failure> {
        if self.stopped {
            return Ok(());
        }
        self.control.post(Command::Stop)?;
        self.completed
            .recv_timeout(CONTROL_TIMEOUT)
            .map_err(|_| Failure::Runtime)?;
        self.stopped = true;
        Ok(())
    }
}

impl Drop for KeyboardThread {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.control.post(Command::Stop);
        }
    }
}

fn apply(command: Command, mut pause: impl FnMut(bool)) -> Result<bool, Failure> {
    match command {
        Command::Pause {
            paused,
            acknowledged,
        } => {
            pause(paused);
            acknowledged.try_send(()).map_err(|_| Failure::Runtime)?;
            Ok(true)
        }
        Command::Stop => {
            pause(true);
            Ok(false)
        }
    }
}

fn run(
    config: HookConfig,
    commands: Receiver<Command>,
    ready: &SyncSender<Result<u32, Failure>>,
) -> Result<(), Failure> {
    // Window creation establishes the queue required by PostThreadMessage.
    let mut input = keyboard_raw::Input::create(config, false)?;
    ready
        .try_send(Ok(unsafe { GetCurrentThreadId() }))
        .map_err(|_| Failure::Startup)?;
    loop {
        let mut message = MSG::default();
        let result = unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) };
        if result <= 0 {
            return Err(Failure::Runtime);
        }
        if message.hwnd.is_null() && message.message == WM_KEYBOARD_CONTROL {
            let command = commands.try_recv().map_err(|_| Failure::Runtime)?;
            if !apply(command, |paused| input.set_paused(paused))? {
                return Ok(());
            }
        } else {
            input.dispatch(&message)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_pumps_and_retires_without_controller_thread_message_dispatch() {
        use windows_sys::Win32::UI::Input::{
            GetRegisteredRawInputDevices, RAWINPUTDEVICE, RIDEV_INPUTSINK, RIDEV_NOLEGACY,
        };
        let registration = || {
            let mut devices = [RAWINPUTDEVICE::default(); 8];
            let mut count = devices.len() as u32;
            let read = unsafe {
                GetRegisteredRawInputDevices(
                    devices.as_mut_ptr(),
                    &mut count,
                    std::mem::size_of::<RAWINPUTDEVICE>() as u32,
                )
            };
            assert_ne!(read, u32::MAX);
            devices
                .into_iter()
                .take(read as usize)
                .find(|device| device.usUsagePage == 1 && device.usUsage == 6)
        };
        assert!(registration().is_none());
        // VK 0 is unassigned: this inert registration observes real input and the test
        // never injects a system key. Key behavior is covered by pure state tests.
        let mut owner = KeyboardThread::start(HookConfig {
            key: 0,
            modifiers: MOD_CONTROL,
        })
        .unwrap();
        let control = owner.control();
        let registered = registration().expect("keyboard Raw Input registration exists");
        assert!(!registered.hwndTarget.is_null());
        // Windows' registration readback omits DEVNOTIFY here. Verify the
        // delivery/pass-through flags it reports, not exact bitwise identity.
        assert_ne!(registered.dwFlags & RIDEV_INPUTSINK, 0);
        assert_eq!(registered.dwFlags & RIDEV_NOLEGACY, 0);
        assert_ne!(control.thread_id, unsafe { GetCurrentThreadId() });
        for _ in 0..16 {
            control.set_paused(false).unwrap();
            control.set_paused(true).unwrap();
        }
        owner.stop().unwrap();
        assert!(registration().is_none());
        owner.stop().unwrap();
        assert_eq!(control.set_paused(false), Err(Failure::Runtime));
    }

    #[test]
    fn lifecycle_acknowledgement_follows_owner_state_and_stop_never_rearms() {
        let (acknowledged, reply) = sync_channel(1);
        let mut paused = false;
        assert!(
            apply(
                Command::Pause {
                    paused: true,
                    acknowledged
                },
                |value| {
                    assert_eq!(reply.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty));
                    paused = value;
                }
            )
            .unwrap()
        );
        assert!(paused);
        assert_eq!(reply.recv_timeout(Duration::ZERO), Ok(()));
        assert!(!apply(Command::Stop, |value| paused = value).unwrap());
        assert!(paused);
    }

    #[test]
    fn retired_controller_cannot_leave_an_unacknowledged_active_registration() {
        let (acknowledged, reply) = sync_channel(1);
        drop(reply);
        assert_eq!(
            apply(
                Command::Pause {
                    paused: true,
                    acknowledged
                },
                |_| {}
            ),
            Err(Failure::Runtime)
        );
    }
}
