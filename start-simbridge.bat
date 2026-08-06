@echo off
setlocal EnableDelayedExpansion

REM Jump to repo root (this .bat's directory)
cd /d "%~dp0"

REM Local launcher runs should not write stability debug files, even if a
REM developer shell has inherited troubleshooting env vars.
set "FF_LOCAL_BAT_LAUNCH=1"
set "STABILITY_DEBUG_LOG=0"
set "STABILITY_DEBUG_ALWAYS_ACTIVE=0"

REM ========================================
REM Preflight checks (fail fast on fresh PCs)
REM ========================================
where node >NUL 2>&1
if errorlevel 1 (
    echo.
    echo ========================================
    echo ERROR: Node.js not found on PATH.
    echo ========================================
    echo Flight Fabric backend requires Node.js.
    echo Install Node.js from https://nodejs.org/
    echo Then re-run this script.
    echo.
    pause
    exit /b 1
)

REM Node resolution for backend files checks backend/node_modules first, then repo root node_modules.
if exist "backend\node_modules\ws\package.json" goto :deps_ok
if exist "node_modules\ws\package.json" goto :deps_ok

where npm >NUL 2>&1
if errorlevel 1 (
    echo.
    echo ========================================
    echo ERROR: Node dependencies not installed, and npm is not available.
    echo ========================================
    echo Missing: ws (WebSocket library)
    echo.
    echo Install/reinstall Node.js from https://nodejs.org/
    echo Then run: npm install
    echo.
    echo Then re-run this script.
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo ERROR: Node dependencies not installed.
echo ========================================
echo Missing: ws (WebSocket library)
echo.
echo In the repo root, run: npm install
echo.
echo Then re-run this script.
echo.
pause
exit /b 1

:deps_ok

:main
echo ========================================
echo   Flight Fabric - Startup
echo ========================================
echo.

REM Resolve effective ports from the built backend config so env vars and user
REM settings stay aligned with what the runtime will actually bind.
set "WS_PORT="
for /f "usebackq delims=" %%V in (`node -e "try { const { resolveBackendRuntimeFile } = require('./scripts/backend-runtime-paths'); const config = require(resolveBackendRuntimeFile('core', 'config.js')); const value=Number(config.ws.port); process.stdout.write(Number.isInteger(value) && value>=1 && value<=65535 ? String(value) : 'INVALID'); } catch (err) { process.stdout.write('8099'); }"`) do (
    set "WS_PORT=%%V"
)
if not defined WS_PORT set "WS_PORT=8099"

set "HTTP_PORT_VALUE="
for /f "usebackq delims=" %%V in (`node -e "try { const { resolveBackendRuntimeFile } = require('./scripts/backend-runtime-paths'); const config = require(resolveBackendRuntimeFile('core', 'config.js')); const value=Number(config.http.port); process.stdout.write(Number.isInteger(value) && value>=1 && value<=65535 ? String(value) : 'INVALID'); } catch (err) { process.stdout.write('8100'); }"`) do (
    set "HTTP_PORT_VALUE=%%V"
)
if not defined HTTP_PORT_VALUE set "HTTP_PORT_VALUE=8100"

set "FF_PORT_VALIDATION_ERROR="
if /I "!WS_PORT!"=="INVALID" set "FF_PORT_VALIDATION_ERROR=WebSocket port must be an integer from 1 through 65535."
if /I "!HTTP_PORT_VALUE!"=="INVALID" set "FF_PORT_VALIDATION_ERROR=HTTP port must be an integer from 1 through 65535."
if not "!WS_PORT!"=="INVALID" if "!WS_PORT!"=="!HTTP_PORT_VALUE!" set "FF_PORT_VALIDATION_ERROR=WebSocket and HTTP ports must be different."
if defined FF_PORT_VALIDATION_ERROR goto :invalid_backend_ports

set "UI_URL=http://localhost:%HTTP_PORT_VALUE%"
set "WS_URL=ws://localhost:%WS_PORT%"
set "MOBILE_SETUP_URL=%UI_URL%/setup"

set "LVAR_PROVIDER_MODE="
for /f "usebackq delims=" %%V in (`node -e "try { const { resolveBackendRuntimeFile } = require('./scripts/backend-runtime-paths'); const config = require(resolveBackendRuntimeFile('core', 'config.js')); process.stdout.write(String((config.lvarSidecar && config.lvarSidecar.provider) || 'auto')); } catch (err) { process.stdout.write('auto'); }"`) do (
    set "LVAR_PROVIDER_MODE=%%V"
)
if not defined LVAR_PROVIDER_MODE set "LVAR_PROVIDER_MODE=auto"

set "LVAR_AUTO_ENABLE_EFFECTIVE="
for /f "usebackq delims=" %%V in (`node -e "try { const { resolveBackendRuntimeFile } = require('./scripts/backend-runtime-paths'); const config = require(resolveBackendRuntimeFile('core', 'config.js')); process.stdout.write(config.lvarSidecar && config.lvarSidecar.autoEnable === false ? '0' : '1'); } catch (err) { process.stdout.write('1'); }"`) do (
    set "LVAR_AUTO_ENABLE_EFFECTIVE=%%V"
)
if not defined LVAR_AUTO_ENABLE_EFFECTIVE set "LVAR_AUTO_ENABLE_EFFECTIVE=1"

set "LVAR_FORCE_ENABLE_EFFECTIVE="
for /f "usebackq delims=" %%V in (`node -e "try { const { resolveBackendRuntimeFile } = require('./scripts/backend-runtime-paths'); const config = require(resolveBackendRuntimeFile('core', 'config.js')); process.stdout.write(config.lvarSidecar && config.lvarSidecar.enable === true ? '1' : '0'); } catch (err) { process.stdout.write('0'); }"`) do (
    set "LVAR_FORCE_ENABLE_EFFECTIVE=%%V"
)
if not defined LVAR_FORCE_ENABLE_EFFECTIVE set "LVAR_FORCE_ENABLE_EFFECTIVE=0"

set "RUST_SIDECAR_EXE=ff-rust-simconnect-sidecar.exe"
set "LVAR_RUST_BINARY="
if exist "%CD%\backend\telemetry-provider\%RUST_SIDECAR_EXE%" set "LVAR_RUST_BINARY=%CD%\backend\telemetry-provider\%RUST_SIDECAR_EXE%"
if not defined LVAR_RUST_BINARY if exist "%CD%\backend\telemetry-provider\rust-simconnect-sidecar\target\release\%RUST_SIDECAR_EXE%" set "LVAR_RUST_BINARY=%CD%\backend\telemetry-provider\rust-simconnect-sidecar\target\release\%RUST_SIDECAR_EXE%"
if not defined LVAR_RUST_BINARY if exist "%CD%\backend-build\telemetry-provider\%RUST_SIDECAR_EXE%" set "LVAR_RUST_BINARY=%CD%\backend-build\telemetry-provider\%RUST_SIDECAR_EXE%"

goto :after_helpers

:classify_flight_fabric_backend_pid
set "FF_BACKEND_PID_OWNER=UNVERIFIED"
set "FF_PID_TO_CHECK=%~1"
if not defined FF_PID_TO_CHECK exit /b 0
for /f "usebackq delims=" %%C in (`powershell.exe -NoProfile -NonInteractive -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = !FF_PID_TO_CHECK!' -ErrorAction SilentlyContinue; $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=if ($p) { Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction SilentlyContinue } else { $null }; if (-not $p -or -not $currentSid -or -not $owner -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $currentSid) { 'UNVERIFIED' } elseif ($p.CommandLine -notmatch '(?i)core[\\/]+simbridge\.js') { 'UNVERIFIED' } elseif ($p.CommandLine -match '(?i)(?:^|\s)--ff-launch-owner=electron(?:\s|$)') { 'ELECTRON' } elseif ($p.CommandLine -match '(?i)(?:^|\s)--ff-launch-owner=batch(?:\s|$)') { 'STANDALONE' } else { 'VERIFIED_UNKNOWN' }" 2^>NUL`) do (
    set "FF_BACKEND_PID_OWNER=%%C"
)
exit /b 0

:verify_backend_launch_nonce
set "FF_BACKEND_LAUNCH_NONCE_MATCH=UNVERIFIED"
set "FF_PID_TO_CHECK=%~1"
set "FF_NONCE_TO_CHECK=%~2"
if not defined FF_PID_TO_CHECK exit /b 0
if not defined FF_NONCE_TO_CHECK exit /b 0
for /f "usebackq delims=" %%C in (`powershell.exe -NoProfile -NonInteractive -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = !FF_PID_TO_CHECK!' -ErrorAction SilentlyContinue; if (-not $p) { 'UNVERIFIED' } elseif ($p.CommandLine -match '(?i)(?:^|\s)--ff-launch-nonce=!FF_NONCE_TO_CHECK!(?:\s|$)') { '1' } else { '0' }" 2^>NUL`) do (
    set "FF_BACKEND_LAUNCH_NONCE_MATCH=%%C"
)
exit /b 0

:find_backend_pid_by_launch_nonce
set "FF_NONCE_BACKEND_PID="
set "FF_NONCE_TO_CHECK=%~1"
if not defined FF_NONCE_TO_CHECK exit /b 0
REM A launch nonce is 64 lowercase hex characters generated immediately before
REM spawn. Require that exact argument and the standalone owner marker. If the
REM result is not unique, fail closed and do not return a mutable PID.
for /f "usebackq delims=" %%C in (`powershell.exe -NoProfile -NonInteractive -Command "$nonce='!FF_NONCE_TO_CHECK!'; if ($nonce -notmatch '^[0-9a-f]{64}$') { exit 0 }; $noncePattern='(?i)(?:^|\s)--ff-launch-nonce='+[regex]::Escape($nonce)+'(?:\s|$)'; $all=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue); $matches=@($all.Where({ $_.CommandLine -match '(?i)core[\\/]+simbridge\.js' -and $_.CommandLine -match '(?i)(?:^|\s)--ff-launch-owner=batch(?:\s|$)' -and $_.CommandLine -match $noncePattern })); if ($matches.Count -eq 1) { [string]$matches[0].ProcessId } elseif ($matches.Count -gt 1) { 'MULTIPLE' }" 2^>NUL`) do (
    set "FF_NONCE_BACKEND_PID=%%C"
)
exit /b 0

:refresh_backend_port_pids
set "P8099_PID="
set "P8100_PID="
REM Parse netstat's fields and the final numeric local-endpoint port. A suffix
REM such as :80990 must never be mistaken for configured port 8099.
for /f "tokens=1,2" %%P in ('node -e "const {execFileSync}=require('child_process');const wanted=new Set(process.argv.slice(1).map(Number));let text='';try{text=execFileSync('netstat',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true});}catch(error){text=String(error.stdout||'');}const byPort=new Map();for(const line of text.split(/\r?\n/)){const fields=line.trim().split(/\s+/);if(fields.length<5)continue;if(fields[0].toUpperCase()==='TCP'&&fields[3].toUpperCase()==='LISTENING'){const match=/:(\d+)$/.exec(fields[1]);if(match){const port=Number(match[1]);if(wanted.has(port)&&/^\d+$/.test(fields[4])){if(byPort.has(port)===false)byPort.set(port,new Set());byPort.get(port).add(fields[4]);}}}}for(const port of wanted){const pids=byPort.get(port);if(pids&&pids.size>0)process.stdout.write(port+' '+(pids.size===1?[...pids][0]:'MULTIPLE')+'\n');}" "!WS_PORT!" "!HTTP_PORT_VALUE!" 2^>NUL') do (
    if "%%P"=="!WS_PORT!" set "P8099_PID=%%Q"
    if "%%P"=="!HTTP_PORT_VALUE!" set "P8100_PID=%%Q"
)
exit /b 0

:capture_standalone_backend_identity
set "FF_CAPTURED_BACKEND_IDENTITY="
set "FF_PID_TO_CHECK=%~1"
set "FF_NONCE_TO_CHECK=%~2"
if not defined FF_PID_TO_CHECK exit /b 0
REM Emit one base64-encoded immutable identity only when PID, creation time,
REM current-user SID, exact command line, standalone owner, and optional nonce
REM all match. Re-capturing the same value closes PID-reuse and command mutation
REM races without putting arbitrary command-line characters into batch syntax.
for /f "usebackq delims=" %%C in (`powershell.exe -NoProfile -NonInteractive -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = !FF_PID_TO_CHECK!' -ErrorAction SilentlyContinue; $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $owner=if ($p) { Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction SilentlyContinue } else { $null }; $commandLine=if ($p) { [string]$p.CommandLine } else { '' }; $nonce='!FF_NONCE_TO_CHECK!'; $nonceOk=if ([string]::IsNullOrEmpty($nonce)) { $true } else { $nonce -match '^[0-9a-f]{64}$' -and $commandLine -match ('(?i)(?:^|\s)--ff-launch-nonce='+[regex]::Escape($nonce)+'(?:\s|$)') }; if ($p -and $currentSid -and $owner -and $owner.ReturnValue -eq 0 -and $owner.Sid -eq $currentSid -and $commandLine -match '(?i)core[\\/]+simbridge\.js' -and $commandLine -match '(?i)(?:^|\s)--ff-launch-owner=batch(?:\s|$)' -and $nonceOk) { $identity=[ordered]@{pid=[int]$p.ProcessId;creationToken=$p.CreationDate.ToUniversalTime().Ticks.ToString();ownerSid=[string]$owner.Sid;commandLine=$commandLine}; $json=$identity ^| ConvertTo-Json -Compress; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) }" 2^>NUL`) do (
    set "FF_CAPTURED_BACKEND_IDENTITY=%%C"
)
exit /b 0

:stop_standalone_backend_pid
set "FF_STOP_PID=%~1"
set "FF_STOP_NONCE=%~2"
if not defined FF_STOP_PID exit /b 0
powershell.exe -NoProfile -NonInteractive -Command "if (Get-Process -Id !FF_STOP_PID! -ErrorAction SilentlyContinue) { exit 0 }; exit 1" >NUL 2>&1
if errorlevel 1 exit /b 0
call :capture_standalone_backend_identity "!FF_STOP_PID!" "!FF_STOP_NONCE!"
set "FF_STOP_ORIGINAL_IDENTITY=!FF_CAPTURED_BACKEND_IDENTITY!"
if not defined FF_STOP_ORIGINAL_IDENTITY (
    echo ERROR: PID !FF_STOP_PID! could not be verified as this user's exact standalone backend. Aborting.
    exit /b 1
)
REM Re-read the complete immutable identity immediately before mutation. A
REM recycled PID, changed creation token/SID/command line, owner, or nonce must
REM fail closed rather than reaching taskkill.
call :capture_standalone_backend_identity "!FF_STOP_PID!" "!FF_STOP_NONCE!"
if not "!FF_CAPTURED_BACKEND_IDENTITY!"=="!FF_STOP_ORIGINAL_IDENTITY!" (
    echo ERROR: PID !FF_STOP_PID! changed identity before it could be stopped. Aborting.
    exit /b 1
)
taskkill /PID !FF_STOP_PID! /T /F >NUL 2>&1
set "FF_TASKKILL_RESULT=!errorlevel!"
if not "!FF_TASKKILL_RESULT!"=="0" (
    powershell.exe -NoProfile -NonInteractive -Command "if (Get-Process -Id !FF_STOP_PID! -ErrorAction SilentlyContinue) { exit 0 }; exit 1" >NUL 2>&1
    if not errorlevel 1 (
        echo ERROR: Failed to stop standalone backend PID !FF_STOP_PID!.
        exit /b 1
    )
)
timeout /t 2 /nobreak >NUL
powershell.exe -NoProfile -NonInteractive -Command "if (Get-Process -Id !FF_STOP_PID! -ErrorAction SilentlyContinue) { exit 0 }; exit 1" >NUL 2>&1
if not errorlevel 1 (
    echo ERROR: Standalone backend PID !FF_STOP_PID! is still running after taskkill.
    exit /b 1
)
exit /b 0

:wait_for_standalone_backend_ready
set "FF_BACKEND_READY_PID="
set "FF_BACKEND_READY_FAILURE="
for /L %%R in (1,1,20) do (
    timeout /t 1 /nobreak >NUL
    call :refresh_backend_port_pids
    set "P8099_OWNER="
    set "P8100_OWNER="
    if defined P8099_PID (
        call :classify_flight_fabric_backend_pid "!P8099_PID!"
        set "P8099_OWNER=!FF_BACKEND_PID_OWNER!"
    )
    if defined P8100_PID (
        if "!P8100_PID!"=="!P8099_PID!" (
            set "P8100_OWNER=!P8099_OWNER!"
        ) else (
            call :classify_flight_fabric_backend_pid "!P8100_PID!"
            set "P8100_OWNER=!FF_BACKEND_PID_OWNER!"
        )
    )
    if defined P8099_PID if not "!P8099_OWNER!"=="STANDALONE" (
        if not "!P8099_OWNER!"=="UNVERIFIED" (
            set "FF_BACKEND_READY_FAILURE=WebSocket port !WS_PORT! was claimed by !P8099_OWNER! PID !P8099_PID!."
            exit /b 1
        )
    )
    if defined P8100_PID if not "!P8100_OWNER!"=="STANDALONE" (
        if not "!P8100_OWNER!"=="UNVERIFIED" (
            set "FF_BACKEND_READY_FAILURE=HTTP port !HTTP_PORT_VALUE! was claimed by !P8100_OWNER! PID !P8100_PID!."
            exit /b 1
        )
    )
    if defined P8099_PID if defined P8100_PID (
        if "!P8099_OWNER!"=="STANDALONE" if "!P8100_OWNER!"=="STANDALONE" (
            if not "!P8099_PID!"=="!P8100_PID!" (
                set "FF_BACKEND_READY_FAILURE=Configured ports were claimed by different standalone backend PIDs !P8099_PID! and !P8100_PID!."
                exit /b 1
            )
        )
        if "!P8099_OWNER!"=="STANDALONE" if "!P8100_OWNER!"=="STANDALONE" (
            if "!P8099_PID!"=="!P8100_PID!" (
                call :verify_backend_launch_nonce "!P8099_PID!" "!FF_BACKEND_LAUNCH_NONCE!"
                if "!FF_BACKEND_LAUNCH_NONCE_MATCH!"=="1" (
                    set "FF_BACKEND_READY_PID=!P8099_PID!"
                    exit /b 0
                )
                if "!FF_BACKEND_LAUNCH_NONCE_MATCH!"=="0" (
                    set "FF_BACKEND_READY_FAILURE=Ports belong to standalone PID !P8099_PID!, but not to this launcher instance."
                    exit /b 1
                )
            )
        )
    )
)
set "FF_BACKEND_READY_FAILURE=Timed out waiting for one marked standalone backend to own ports !WS_PORT! and !HTTP_PORT_VALUE!."
exit /b 1

:cleanup_failed_backend_launch
set "FF_FAILED_LAUNCH_CLEANUP="
if not defined FF_BACKEND_LAUNCH_NONCE exit /b 0
call :find_backend_pid_by_launch_nonce "!FF_BACKEND_LAUNCH_NONCE!"
if not defined FF_NONCE_BACKEND_PID exit /b 0
if "!FF_NONCE_BACKEND_PID!"=="MULTIPLE" (
    set "FF_FAILED_LAUNCH_CLEANUP=Multiple processes claimed this launch nonce; no process was stopped."
    exit /b 1
)
echo Stopping failed backend launch PID !FF_NONCE_BACKEND_PID! and its sidecars...
call :stop_standalone_backend_pid "!FF_NONCE_BACKEND_PID!" "!FF_BACKEND_LAUNCH_NONCE!"
if errorlevel 1 (
    set "FF_FAILED_LAUNCH_CLEANUP=Could not safely stop the backend from this launch; close its backend window manually."
    exit /b 1
)
set "FF_FAILED_LAUNCH_CLEANUP=The backend from this failed launch was stopped."
exit /b 0

:wait_for_wrapper_prepared
set "FF_WRAPPER_PREPARE_FAILURE="
for /L %%R in (1,1,120) do (
    set "FF_WRAPPER_STATE="
    set "FF_WRAPPER_STATE_WS="
    set "FF_WRAPPER_STATE_HTTP="
    for /f "usebackq tokens=1,2,3" %%A in (`node -e "try { const wrapper=require('./scripts/start-backend-runtime'); const state=wrapper.readWrapperReady(process.argv[1]); if (state === null) process.exit(0); if (state.status==='prepared') { const ws=Number(state.wsPort); const http=Number(state.httpPort); const valid=Number.isInteger(ws) ^&^& ws^>=1 ^&^& ws^<=65535 ^&^& Number.isInteger(http) ^&^& http^>=1 ^&^& http^<=65535 ^&^& (ws === http ? false : true); process.stdout.write(valid ? 'PREPARED '+ws+' '+http : 'INVALID'); } else if (state.status==='error') { process.stdout.write('ERROR '+String(state.code ^|^| 'unknown')); } } catch (_) {}" "!FF_BACKEND_LAUNCH_NONCE!" 2^>NUL`) do (
        set "FF_WRAPPER_STATE=%%A"
        set "FF_WRAPPER_STATE_WS=%%B"
        set "FF_WRAPPER_STATE_HTTP=%%C"
    )
    if "!FF_WRAPPER_STATE!"=="PREPARED" (
        set "WS_PORT=!FF_WRAPPER_STATE_WS!"
        set "HTTP_PORT_VALUE=!FF_WRAPPER_STATE_HTTP!"
        set "FF_WRAPPER_PREPARED=1"
        exit /b 0
    )
    if "!FF_WRAPPER_STATE!"=="INVALID" (
        set "FF_WRAPPER_PREPARE_FAILURE=The wrapper returned invalid or duplicate runtime ports."
        exit /b 1
    )
    if "!FF_WRAPPER_STATE!"=="ERROR" (
        set "FF_WRAPPER_PREPARE_FAILURE=Wrapper preparation failed: !FF_WRAPPER_STATE_WS!."
        exit /b 1
    )
    timeout /t 1 /nobreak >NUL
)
set "FF_WRAPPER_PREPARE_FAILURE=Timed out waiting for locked runtime preparation."
exit /b 1

:wait_for_wrapper_ready
set "FF_WRAPPER_READINESS_FAILURE="
for /L %%R in (1,1,35) do (
    set "FF_WRAPPER_STATE="
    set "FF_WRAPPER_STATE_DETAIL="
    for /f "usebackq tokens=1,2" %%A in (`node -e "try { const wrapper=require('./scripts/start-backend-runtime'); const state=wrapper.readWrapperReady(process.argv[1]); if (state === null) process.exit(0); if (state.status==='ready') process.stdout.write('READY'); else if (state.status==='error') process.stdout.write('ERROR '+String(state.code ^|^| 'unknown')); } catch (_) {}" "!FF_BACKEND_LAUNCH_NONCE!" 2^>NUL`) do (
        set "FF_WRAPPER_STATE=%%A"
        set "FF_WRAPPER_STATE_DETAIL=%%B"
    )
    if "!FF_WRAPPER_STATE!"=="READY" exit /b 0
    if "!FF_WRAPPER_STATE!"=="ERROR" (
        set "FF_WRAPPER_READINESS_FAILURE=Backend startup failed: !FF_WRAPPER_STATE_DETAIL!."
        exit /b 1
    )
    timeout /t 1 /nobreak >NUL
)
set "FF_WRAPPER_READINESS_FAILURE=Timed out waiting for the process guardian and canonical backend readiness marker."
exit /b 1

:signal_prepared_wrapper
if not "!FF_WRAPPER_PREPARED!"=="1" exit /b 0
node -e "require('./scripts/start-backend-runtime').writeWrapperControl(process.argv[1], process.argv[2])" "!FF_BACKEND_LAUNCH_NONCE!" "%~1" >NUL 2>&1
if errorlevel 1 exit /b 1
set "FF_WRAPPER_PREPARED="
exit /b 0

:abort_prepared_wrapper
if not "!FF_WRAPPER_PREPARED!"=="1" exit /b 0
call :signal_prepared_wrapper abort
exit /b 0

:cleanup_wrapper_handshake
if not defined FF_BACKEND_LAUNCH_NONCE exit /b 0
node -e "require('./scripts/start-backend-runtime').cleanupWrapperHandshake(process.argv[1])" "!FF_BACKEND_LAUNCH_NONCE!" >NUL 2>&1
exit /b 0

:after_helpers

REM ========================================
REM Port-in-use check (avoid EADDRINUSE)
REM ========================================
REM Dry runs must never terminate an existing backend.
if /I "%FF_START_SIMBRIDGE_DRY_RUN%"=="1" goto :ports_ready_for_prep

call :refresh_backend_port_pids
set "P8099_OWNER="
set "P8100_OWNER="
if defined P8099_PID (
    call :classify_flight_fabric_backend_pid "!P8099_PID!"
    set "P8099_OWNER=!FF_BACKEND_PID_OWNER!"
)
if defined P8100_PID (
    if "!P8100_PID!"=="!P8099_PID!" (
        set "P8100_OWNER=!P8099_OWNER!"
    ) else (
        call :classify_flight_fabric_backend_pid "!P8100_PID!"
        set "P8100_OWNER=!FF_BACKEND_PID_OWNER!"
    )
)

if "!P8099_OWNER!"=="ELECTRON" (
    set "FF_CONFLICT_PID=!P8099_PID!"
    goto :electron_backend_conflict
)
if "!P8100_OWNER!"=="ELECTRON" (
    set "FF_CONFLICT_PID=!P8100_PID!"
    goto :electron_backend_conflict
)
if defined P8099_PID (
    if not "!P8099_OWNER!"=="STANDALONE" (
        set "FF_CONFLICT_PID=!P8099_PID!"
        goto :unknown_backend_conflict
    )
)
if defined P8100_PID (
    if not "!P8100_OWNER!"=="STANDALONE" (
        set "FF_CONFLICT_PID=!P8100_PID!"
        goto :unknown_backend_conflict
    )
)

if defined P8099_PID (
    echo Verified standalone Flight Fabric backend detected; stopping PID !P8099_PID! and its sidecars.
    call :stop_standalone_backend_pid "!P8099_PID!"
    if errorlevel 1 goto :backend_cleanup_failed
    if "!P8100_PID!"=="!P8099_PID!" set "P8100_PID="
)
if defined P8100_PID (
    echo Verified standalone Flight Fabric backend detected; stopping PID !P8100_PID! and its sidecars.
    call :stop_standalone_backend_pid "!P8100_PID!"
    if errorlevel 1 goto :backend_cleanup_failed
)

call :refresh_backend_port_pids
if defined P8099_PID goto :backend_cleanup_failed
if defined P8100_PID goto :backend_cleanup_failed

:ports_ready_for_prep

if /I not "%FF_START_SIMBRIDGE_DRY_RUN%"=="1" goto :start_locked_preparation

echo.
echo [prep] Ensuring built backend and frontend are current...
node scripts\prepare-start-runtime.js
if errorlevel 1 (
    echo.
    echo ========================================
    echo ERROR: Runtime preparation failed.
    echo ========================================
    echo Fix the build error above, then re-run this script.
    echo.
    pause
    exit /b 1
)

goto :start_services

:start_locked_preparation
REM Bind preparation and readiness to this exact wrapper invocation. The
REM wrapper consumes and canonicalizes ownership arguments before forwarding.
set "FF_BACKEND_LAUNCH_NONCE="
for /f "usebackq delims=" %%N in (`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" 2^>NUL`) do (
    set "FF_BACKEND_LAUNCH_NONCE=%%N"
)
if not defined FF_BACKEND_LAUNCH_NONCE goto :backend_nonce_failed

echo.
echo [prep] Ensuring built backend and frontend are current under the runtime lock...
echo [1/2] Preparing and starting Flight Fabric backend ^(in new window^)...
start "Flight Fabric Backend" cmd /k "node scripts\start-backend-runtime.js --ff-wrapper-prepare-runtime --ff-launch-owner=batch --ff-launch-nonce=!FF_BACKEND_LAUNCH_NONCE!"

REM The wrapper holds the shared launch lock while it prepares dist output. It
REM does not spawn the backend until this launcher validates the resulting
REM ports, rechecks both owners, and sends the nonce-bound go control.
call :wait_for_wrapper_prepared
if errorlevel 1 goto :wrapper_prepare_failed

set "FF_PORT_VALIDATION_ERROR="
if not defined WS_PORT set "FF_PORT_VALIDATION_ERROR=WebSocket port must be an integer from 1 through 65535."
if not defined HTTP_PORT_VALUE set "FF_PORT_VALIDATION_ERROR=HTTP port must be an integer from 1 through 65535."
if "!WS_PORT!"=="!HTTP_PORT_VALUE!" set "FF_PORT_VALIDATION_ERROR=WebSocket and HTTP ports must be different."
if defined FF_PORT_VALIDATION_ERROR goto :invalid_backend_ports

set "UI_URL=http://localhost:!HTTP_PORT_VALUE!"
set "WS_URL=ws://localhost:!WS_PORT!"
set "MOBILE_SETUP_URL=!UI_URL!/setup"

REM Preparation may have changed the effective config, and another process may
REM have bound its ports meanwhile. Re-resolve and classify both post-build
REM listeners before authorizing the backend child to exist.
call :refresh_backend_port_pids
set "P8099_OWNER="
set "P8100_OWNER="
if defined P8099_PID (
    call :classify_flight_fabric_backend_pid "!P8099_PID!"
    set "P8099_OWNER=!FF_BACKEND_PID_OWNER!"
)
if defined P8100_PID (
    if "!P8100_PID!"=="!P8099_PID!" (
        set "P8100_OWNER=!P8099_OWNER!"
    ) else (
        call :classify_flight_fabric_backend_pid "!P8100_PID!"
        set "P8100_OWNER=!FF_BACKEND_PID_OWNER!"
    )
)

if "!P8099_OWNER!"=="ELECTRON" (
    set "FF_CONFLICT_PID=!P8099_PID!"
    goto :electron_backend_conflict
)
if "!P8100_OWNER!"=="ELECTRON" (
    set "FF_CONFLICT_PID=!P8100_PID!"
    goto :electron_backend_conflict
)
if defined P8099_PID if not "!P8099_OWNER!"=="STANDALONE" (
    set "FF_CONFLICT_PID=!P8099_PID!"
    goto :unknown_backend_conflict
)
if defined P8100_PID if not "!P8100_OWNER!"=="STANDALONE" (
    set "FF_CONFLICT_PID=!P8100_PID!"
    goto :unknown_backend_conflict
)

if defined P8099_PID (
    echo Verified standalone Flight Fabric backend detected after preparation; stopping PID !P8099_PID! and its sidecars.
    call :stop_standalone_backend_pid "!P8099_PID!"
    if errorlevel 1 goto :backend_cleanup_failed
    if "!P8100_PID!"=="!P8099_PID!" set "P8100_PID="
)
if defined P8100_PID (
    echo Verified standalone Flight Fabric backend detected after preparation; stopping PID !P8100_PID! and its sidecars.
    call :stop_standalone_backend_pid "!P8100_PID!"
    if errorlevel 1 goto :backend_cleanup_failed
)

call :refresh_backend_port_pids
if defined P8099_PID goto :backend_cleanup_failed
if defined P8100_PID goto :backend_cleanup_failed

call :signal_prepared_wrapper go
if errorlevel 1 goto :wrapper_control_failed
call :wait_for_wrapper_ready
if errorlevel 1 goto :wrapper_readiness_failed
call :cleanup_wrapper_handshake
goto :start_services

:electron_backend_conflict
call :abort_prepared_wrapper
echo.
echo ========================================
echo ERROR: Flight Fabric desktop backend is already running ^(PID !FF_CONFLICT_PID!^).
echo ========================================
echo The Electron app may be hidden in the system tray.
echo Use Quit from the Flight Fabric tray menu, then re-run this launcher.
echo This launcher will not detach or replace a backend owned by the desktop app.
echo.
pause
exit /b 1

:unknown_backend_conflict
call :abort_prepared_wrapper
echo.
echo ========================================
echo ERROR: A backend port is owned by an unrecognized process ^(PID !FF_CONFLICT_PID!^).
echo ========================================
echo Close that process yourself, then re-run this launcher.
echo For safety, this launcher only stops backends marked as standalone batch launches.
echo.
pause
exit /b 1

:backend_cleanup_failed
call :abort_prepared_wrapper
echo.
echo ========================================
echo ERROR: Existing backend cleanup did not release both configured ports.
echo ========================================
echo Close the existing backend yourself, then re-run this launcher.
echo.
pause
exit /b 1

:late_backend_conflict
call :abort_prepared_wrapper
echo.
echo ========================================
echo ERROR: A backend port became busy while startup preparation was running.
echo ========================================
echo PID: !FF_CONFLICT_PID!
echo No process was stopped because ownership may have changed during startup.
echo Close the conflicting process yourself, then re-run this launcher.
echo.
pause
exit /b 1

:wrapper_prepare_failed
call :cleanup_wrapper_handshake
echo.
echo ========================================
echo ERROR: Runtime preparation failed while holding the launch lock.
echo ========================================
if defined FF_WRAPPER_PREPARE_FAILURE echo !FF_WRAPPER_PREPARE_FAILURE!
echo Fix the build error in the backend window, then re-run this script.
echo.
pause
exit /b 1

:wrapper_control_failed
call :abort_prepared_wrapper
call :cleanup_wrapper_handshake
echo.
echo ========================================
echo ERROR: Could not authorize the prepared backend launch.
echo ========================================
echo The backend was not intentionally started. Close its window and retry.
echo.
pause
exit /b 1

:wrapper_readiness_failed
call :cleanup_wrapper_handshake
call :cleanup_failed_backend_launch
echo.
echo ========================================
echo ERROR: Backend startup did not reach its guarded ready state.
echo ========================================
if defined FF_WRAPPER_READINESS_FAILURE echo !FF_WRAPPER_READINESS_FAILURE!
if defined FF_FAILED_LAUNCH_CLEANUP echo !FF_FAILED_LAUNCH_CLEANUP!
echo The desktop UI was not opened.
echo.
pause
exit /b 1


:backend_launch_failed
call :cleanup_failed_backend_launch
echo.
echo ========================================
echo ERROR: Flight Fabric backend did not become ready.
echo ========================================
if defined FF_BACKEND_READY_FAILURE echo !FF_BACKEND_READY_FAILURE!
if defined FF_FAILED_LAUNCH_CLEANUP echo !FF_FAILED_LAUNCH_CLEANUP!
echo The desktop UI was not opened and this launcher will not report success.
echo Check the backend window for the startup error, then close it before retrying.
echo.
pause
exit /b 1

:invalid_backend_ports
call :abort_prepared_wrapper
echo.
echo ========================================
echo ERROR: Invalid backend port configuration.
echo ========================================
echo !FF_PORT_VALIDATION_ERROR!
echo Set two different port numbers from 1 through 65535, then re-run this launcher.
echo.
pause
exit /b 1

:backend_nonce_failed
echo.
echo ========================================
echo ERROR: Could not create a secure backend launch identity.
echo ========================================
echo No backend was started. Re-run this launcher after checking Node.js.
echo.
pause
exit /b 1

:start_services

REM ========================================
REM LVAR sidecar status (Rust-only runtime)
REM ========================================
if /I "!LVAR_FORCE_ENABLE_EFFECTIVE!"=="1" (
    echo [LVAR] Sidecar explicitly enabled by config.
) else (
    if /I "!LVAR_AUTO_ENABLE_EFFECTIVE!"=="0" (
        echo [LVAR] Sidecar auto-enable disabled by config.
    ) else (
        if /I "!LVAR_PROVIDER_MODE!"=="rust" (
            echo [LVAR] Provider mode: rust ^(forced^)
        ) else (
            echo [LVAR] Provider mode: auto ^(Rust sidecar when available^)
        )

        if defined LVAR_RUST_BINARY (
            echo [LVAR] Rust candidate: !LVAR_RUST_BINARY!
        ) else (
            echo [LVAR] Rust candidate not found in default launcher paths.
        )

        if /I "!LVAR_PROVIDER_MODE!"=="rust" if not defined LVAR_RUST_BINARY (
            echo [LVAR] WARNING: Rust is forced but no default Rust binary was found.
        )
    )
)

echo.
echo ========================================
echo   Services URLs:
echo ========================================
echo   Desktop UI:        !UI_URL!
echo   Backend WebSocket: !WS_URL!
echo   Mobile setup:      !MOBILE_SETUP_URL!
echo ========================================
echo.

if /I "%FF_START_SIMBRIDGE_DRY_RUN%"=="1" (
    echo [DRY RUN] Skipping backend launch and browser open.
    endlocal
    exit /b 0
)

REM The wrapper has completed preparation under the shared lock and established
REM its native process guardian. Do not report success until its nonce-marked
REM backend child owns both configured listeners.
call :wait_for_standalone_backend_ready
if errorlevel 1 goto :backend_launch_failed

REM Open the main UI via the local HTTP server (avoids file:// security restrictions)
echo [2/2] Backend ready ^(PID !FF_BACKEND_READY_PID!^). Opening desktop UI at !UI_URL! ...
start "" "!UI_URL!"

echo.
echo Backend running in a separate window. Close it (or Ctrl+C) to stop.
endlocal
