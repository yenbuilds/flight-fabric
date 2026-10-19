
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
