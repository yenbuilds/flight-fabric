
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    const CREATE_NO_WINDOW: Dword = 0x0800_0000;

    #[test]
    fn opened_owner_handle_signals_after_that_exact_process_exits() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("owner test process should start");
        let owner = OwnerProcessHandle::open(child.id())
            .expect("owner process should be openable with SYNCHRONIZE access");

        let initial = owner.wait(0);
        if initial != Ok(WaitOutcome::TimedOut) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("live owner process handle should not be signaled: {initial:?}");
        }

        child.kill().expect("owner test process should terminate");
        child.wait().expect("owner test process should be reaped");
        assert_eq!(
            owner.wait(Duration::from_secs(2).as_millis() as Dword),
            Ok(WaitOutcome::Signaled)
        );
    }
