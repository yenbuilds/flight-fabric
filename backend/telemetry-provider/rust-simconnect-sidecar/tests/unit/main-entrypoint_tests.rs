
    use super::{
        parse_owner_pid, parse_target_pid, run_process_guardian, should_enable_mobiflight,
        should_run_connection_probe, should_run_process_guardian, start_owner_lifeline,
        OWNER_LIFELINE_VERSION,
    };

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn mobiflight_mode_is_selected_only_by_explicit_sidecar_role_flags() {
        assert!(should_enable_mobiflight(&args(&["sidecar"])));
        assert!(!should_enable_mobiflight(&args(&[
            "sidecar",
            "--simvars-bridge"
        ])));
        assert!(!should_enable_mobiflight(&args(&[
            "sidecar",
            "--sdk-clientdata-bridge"
        ])));
    }

    #[test]
    fn connection_probe_mode_is_explicit_and_cannot_reenter_the_sidecar_loop() {
        assert!(!should_run_connection_probe(&args(&["sidecar"])));
        assert!(should_run_connection_probe(&args(&[
            "sidecar",
            "--connection-probe"
        ])));
    }

    #[test]
    fn process_guardian_mode_is_explicit_and_separate_from_sidecar_modes() {
        assert!(!should_run_process_guardian(&args(&["sidecar"])));
        assert!(should_run_process_guardian(&args(&[
            "sidecar",
            "--process-guardian"
        ])));
        assert!(run_process_guardian(&args(&["sidecar", "--process-guardian"]))
            .expect_err("guardian must require both exact process identities")
            .contains("requires --ff-owner-pid"));
        assert!(run_process_guardian(&args(&[
            "sidecar",
            "--process-guardian",
            "--probe",
            "--ff-owner-pid=1",
            "--ff-target-pid=2",
        ]))
        .expect_err("guardian and probe roles must not be combined")
        .contains("cannot be combined"));
    }

    #[test]
    fn owner_pid_argument_accepts_one_positive_decimal_pid() {
        assert_eq!(parse_owner_pid(&args(&["sidecar"])), Ok(None));
        assert_eq!(
            parse_owner_pid(&args(&["sidecar", "--ff-owner-pid=4242"])),
            Ok(Some(4242))
        );
    }

    #[test]
    fn malformed_or_ambiguous_owner_pid_arguments_fail_closed() {
        for values in [
            vec!["sidecar", "--ff-owner-pid"],
            vec!["sidecar", "--ff-owner-pid="],
            vec!["sidecar", "--ff-owner-pid=0"],
            vec!["sidecar", "--ff-owner-pid=-1"],
            vec!["sidecar", "--ff-owner-pid=12x"],
            vec!["sidecar", "--ff-owner-pid=4294967296"],
            vec!["sidecar", "--ff-owner-pid=12", "--ff-owner-pid=12"],
        ] {
            assert!(
                parse_owner_pid(&args(&values)).is_err(),
                "owner PID arguments should be rejected: {values:?}"
            );
        }
    }

    #[test]
    fn target_pid_argument_is_strict_and_unambiguous() {
        assert_eq!(
            parse_target_pid(&args(&["sidecar", "--ff-target-pid=4242"])),
            Ok(Some(4242))
        );
        for values in [
            vec!["sidecar", "--ff-target-pid"],
            vec!["sidecar", "--ff-target-pid=0"],
            vec!["sidecar", "--ff-target-pid=-1"],
            vec![
                "sidecar",
                "--ff-target-pid=12",
                "--ff-target-pid=12",
            ],
        ] {
            assert!(parse_target_pid(&args(&values)).is_err());
        }
    }

    #[test]
    fn every_process_except_capability_probe_requires_an_owner() {
        let error = start_owner_lifeline(&args(&["sidecar", "--simvars-bridge"]))
            .expect_err("long-running sidecars must reject a missing owner PID");
        assert!(error.contains("required for every non-probe mode"));

        assert_eq!(start_owner_lifeline(&args(&["sidecar", "--probe"])), Ok(()));
        let connection_error =
            start_owner_lifeline(&args(&["sidecar", "--connection-probe"]))
                .expect_err("a disposable connection probe must watch its spawning sidecar");
        assert!(connection_error.contains("required for every non-probe mode"));
        assert_eq!(OWNER_LIFELINE_VERSION, 1);
    }
