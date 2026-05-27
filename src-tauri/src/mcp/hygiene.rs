//! Process hygiene — ensures spawned MCP children don't outlive MatrixOS
//! during normal shutdown. `kill -9 MatrixOS` on POSIX is a documented residual.

#[cfg(windows)]
pub mod windows {
    use std::sync::OnceLock;
    use win32job::{ExtendedLimitInfo, Job};
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::winnt::PROCESS_SET_QUOTA;

    static JOB: OnceLock<Job> = OnceLock::new();

    /// Singleton job-object with KILL_ON_JOB_CLOSE — every MCP child is assigned
    /// to it, so the OS reaps them when MatrixOS's handle drops.
    pub fn ensure_job() -> &'static Job {
        JOB.get_or_init(|| {
            let mut info = ExtendedLimitInfo::new();
            info.limit_kill_on_job_close();
            Job::create_with_limit_info(&mut info).expect("failed to create process Job")
        })
    }

    pub fn assign_to_job(pid: u32) -> Result<(), String> {
        // AssignProcessToJobObject requires a process HANDLE, not a PID.
        // PROCESS_SET_QUOTA | PROCESS_TERMINATE is the minimum required access.
        let handle = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | winapi::um::winnt::PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(format!("OpenProcess({}): handle is null", pid));
        }
        let result = ensure_job()
            .assign_process(handle)
            .map_err(|e| format!("assign_process({}): {}", pid, e));
        unsafe { CloseHandle(handle) };
        result
    }
}

#[cfg(unix)]
pub mod unix {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    use std::time::Duration;

    /// SIGTERM the process group, sleep 500 ms, then SIGKILL if anything's left.
    /// Used by mcp_disconnect and the ExitRequested handler.
    pub async fn terminate_group(pgid: u32) {
        let pgid = Pid::from_raw(pgid as i32);
        let _ = killpg(pgid, Signal::SIGTERM);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let _ = killpg(pgid, Signal::SIGKILL);
    }
}

// Cross-platform shim invoked by stdio::spawn_stdio after Command::spawn.
pub fn after_spawn(pid: u32) -> Result<(), String> {
    #[cfg(windows)] { windows::assign_to_job(pid)?; }
    #[cfg(unix)] { let _ = pid; /* group set via Command pre_exec in stdio.rs */ }
    Ok(())
}
