
    use super::*;

    #[test]
    fn simconnect_pipe_gate_only_opens_when_the_server_is_accepting_connections() {
        assert_eq!(classify_pipe_wait(true, ERROR_FILE_NOT_FOUND), Ok(true));
        for error in [
            ERROR_FILE_NOT_FOUND,
            ERROR_PATH_NOT_FOUND,
            ERROR_BROKEN_PIPE,
            ERROR_SEM_TIMEOUT,
            ERROR_PIPE_BUSY,
            ERROR_PIPE_NOT_CONNECTED,
        ] {
            assert_eq!(classify_pipe_wait(false, error), Ok(false));
        }
        assert_eq!(classify_pipe_wait(false, 5), Err(5));
    }

    #[test]
    fn simconnect_pipe_gate_uses_the_local_sdk_endpoint() {
        let wide = simconnect_pipe_name_wide();
        assert_eq!(wide.last(), Some(&0));
        assert_eq!(
            String::from_utf16(&wide[..wide.len() - 1]).expect("pipe name should be valid UTF-16"),
            SIMCONNECT_PIPE_NAME
        );
    }

    #[test]
    fn simconnect_config_candidates_cover_and_deduplicate_client_directories() {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_config_directory(
            &mut candidates,
            &mut seen,
            Some(Path::new(r"C:\Flight Fabric")),
        );
        push_config_directory(
            &mut candidates,
            &mut seen,
            Some(Path::new(r"C:\flight fabric")),
        );

        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0],
            PathBuf::from(r"C:\Flight Fabric\SimConnect.cfg")
        );
    }

    #[test]
    fn simconnect_config_discovery_covers_executable_cwd_and_dll_locations() {
        let configs = simconnect_config_candidates();
        let executable = env::current_exe().expect("test executable path should resolve");
        let current_dir = env::current_dir().expect("test working directory should resolve");
        assert!(configs.contains(
            &executable
                .parent()
                .expect("test executable should have a parent")
                .join("SimConnect.cfg")
        ));
        assert!(configs.contains(&current_dir.join("SimConnect.cfg")));

        for dll in simconnect_candidates() {
            assert!(configs.contains(
                &dll.path
                    .parent()
                    .expect("DLL candidate should have a parent")
                    .join("SimConnect.cfg")
            ));
        }
    }

    #[test]
    fn simconnect_dll_candidates_require_absolute_trusted_paths() {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_candidate(
            &mut candidates,
            &mut seen,
            Some(PathBuf::from("relative/SimConnect.dll")),
        );
        assert_eq!(candidates.len(), 0);

        assert!(is_rust_sidecar_target_dir(Path::new(
            r"C:\ff\backend\telemetry-provider\rust-simconnect-sidecar\target\release"
        )));
        assert!(!is_rust_sidecar_target_dir(Path::new(
            r"C:\ff\backend\telemetry-provider"
        )));
    }

    #[test]
    fn push_candidate_appends_dll_name_and_deduplicates_case_insensitively() {
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        push_candidate(
            &mut candidates,
            &mut seen,
            Some(PathBuf::from(r"C:\Flight Fabric\SimConnect")),
        );
        push_candidate(
            &mut candidates,
            &mut seen,
            Some(PathBuf::from(r"C:\flight fabric\simconnect\SimConnect.dll")),
        );

        assert_eq!(candidates.len(), 1);
        assert!(candidates[0]
            .load_name()
            .ends_with(r"Flight Fabric\SimConnect\SimConnect.dll"));
    }
