
    use super::*;
    #[test]
    fn stale_commands_cannot_resume_motion_until_explicit_disable() {
        let now = Instant::now(); let mut lease = TugLease::default();
        assert!(!lease.active());
        lease.command("TUG_HEADING", 123, now); assert!(!lease.active());
        assert!(lease.start(now));
        assert!(!lease.start(now));
        assert!(lease.active()); assert!(!lease.blocked(now + Duration::from_secs(1)));
        assert!(lease.blocked(now + Duration::from_millis(1500)));
        lease.expire(); lease.stopped();
        assert!(lease.blocked(now));
        lease.command("TUG_DISABLE", 0, now); assert!(!lease.blocked(now));
        assert!(lease.start(now));
        lease.command("TUG_SPEED", 0, now); assert!(lease.active());
        lease.command("TUG_DISABLE", 0, now); assert!(!lease.active());
    }
    #[test]
    fn headings_renew_the_lease_during_coupling_but_cannot_start_or_revive_it() {
        let now = Instant::now(); let mut lease = TugLease::default();
        lease.command("TUG_HEADING", 0, now); assert!(!lease.active());
        assert!(lease.start(now));
        for second in 1..=60 {
            let time = now + Duration::from_secs(second);
            assert!(!lease.blocked(time));
            lease.command("TUG_HEADING", 123, time);
        }
        let stale = now + Duration::from_secs(62);
        lease.command("TUG_HEADING", 123, stale);
        assert!(lease.blocked(stale));
        lease.expire(); lease.stopped();
        assert!(!lease.start(stale));
        lease.command("TUG_DISABLE", 0, stale);
        assert!(lease.start(stale));
    }
