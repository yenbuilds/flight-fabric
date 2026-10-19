
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: Dword = 0x0800_0000;

    fn sleeping_process() -> std::process::Child {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("guardian test process should start")
    }

    #[test]
    fn exact_owner_exit_terminates_an_unresponsive_target() {
        let mut owner = sleeping_process();
        let mut target = sleeping_process();
        let guardian = ProcessGuardian::open(owner.id(), target.id())
            .expect("guardian should open exact process handles");

        owner.kill().expect("owner should terminate");
        owner.wait().expect("owner should be reaped");
        guardian
            .enforce()
            .expect("guardian should terminate the target after owner death");

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if target
                .try_wait()
                .expect("target should be queryable")
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = target.kill();
                let _ = target.wait();
                panic!("guarded target survived owner exit");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn target_exit_releases_guardian_without_touching_owner() {
        let mut owner = sleeping_process();
        let mut target = sleeping_process();
        let guardian = ProcessGuardian::open(owner.id(), target.id())
            .expect("guardian should open exact process handles");

        target.kill().expect("target should terminate");
        target.wait().expect("target should be reaped");
        guardian
            .enforce()
            .expect("guardian should finish when the target exits normally");
        assert!(owner
            .try_wait()
            .expect("owner should be queryable")
            .is_none());

        owner.kill().expect("owner cleanup should terminate");
        owner.wait().expect("owner cleanup should be reaped");
    }

    #[test]
    fn owner_already_gone_during_guardian_start_still_terminates_target() {
        let mut target = sleeping_process();

        let error = match ProcessGuardian::open(u32::MAX, target.id()) {
            Ok(_) => panic!("an already-gone owner must reject guardian startup"),
            Err(error) => error,
        };
        assert!(error.contains("guarded target PID"));

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if target
                .try_wait()
                .expect("target should be queryable")
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = target.kill();
                let _ = target.wait();
                panic!("target survived a guardian start after owner death");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
