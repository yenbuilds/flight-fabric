
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: Dword = 0x0800_0000;

    #[test]
    fn closing_job_terminates_an_assigned_blocked_process() {
        let job = KillOnCloseJob::new().expect("kill-on-close job should be created");
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("blocked test process should start");
        job.assign(&child)
            .expect("blocked test process should join the job");
        assert!(child
            .try_wait()
            .expect("blocked test process should be queryable")
            .is_none());

        drop(job); // Simulates the parent being force-killed and all its handles closing.

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if child
                .try_wait()
                .expect("terminated test process should be queryable")
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("kill-on-close job did not terminate its blocked process");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
