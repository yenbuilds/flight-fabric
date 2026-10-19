
    use super::*;
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    #[test]
    fn unconfirmed_keyboard_shutdown_exits_without_waiting_for_the_writer() {
        const CHILD_FLAG: &str = "FF_PTT_UNCONFIRMED_SHUTDOWN_TEST";
        if env::var_os(CHILD_FLAG).is_some() {
            // Artificially stalled output is never joined if the input owner
            // has not acknowledged removal. No real input registration is made.
            let writer = thread::spawn(|| {
                loop {
                    thread::park();
                }
            });
            finish_run(writer, true, Ok(()), Err(Failure::Runtime));
            panic!("unconfirmed shutdown must terminate the helper");
        }
        let mut child = Command::new(env::current_exe().unwrap())
            .args(["--exact", "controller_runtime::tests::unconfirmed_keyboard_shutdown_exits_without_waiting_for_the_writer"])
            .env(CHILD_FLAG, "1")
            .creation_flags(0x08000000)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(status.code(), Some(Failure::Runtime as i32));
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("shutdown waited for the stalled output writer");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn only_exact_bounded_setup_or_complete_binding_is_accepted() {
        let parse =
            |args: &[&str]| options(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(parse(&["--controller-setup", "--seconds", "30"]).is_ok());
        assert!(parse(&["--controller-setup", "--seconds", "0"]).is_err());
        assert!(
            parse(&[
                "--controller-integration",
                "--shortcut",
                "Control+Alt+Space",
                "--device-path",
                "path",
                "--report-id",
                "255",
                "--collection",
                "65535",
                "--button",
                "65535"
            ])
            .is_ok()
        );
        assert!(
            parse(&[
                "--controller-integration",
                "--shortcut",
                "",
                "--device-path",
                "path",
                "--report-id",
                "256",
                "--collection",
                "0",
                "--button",
                "1"
            ])
            .is_err()
        );
    }
