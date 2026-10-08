; Runs before CHECK_APP_RUNNING, uninstallOldVersion and application extraction.
; A prerequisite failure must never remove a working FlightFabric installation.
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "x64.nsh"
!include "${PROJECT_DIR}\resources\vc-runtime\vc-runtime.nsh"

; electron-builder registers its plugin directories after reading this include.
; Defer function compilation until customHeader, when StdUtils is available.
!macro customHeader
!ifndef BUILD_UNINSTALLER
Var ffRuntimeReady
Var ffRuntimeVersion
Var ffRuntimeResult
Var ffRuntimeInstalled

Function ffCheckRuntime
  StrCpy $ffRuntimeReady "0"
  ; NSIS is 32-bit, but our application and the runtime we require are x64.
  ${DisableX64FSRedirection}
  IfFileExists "$WINDIR\System32\vcruntime140.dll" 0 ffRuntimeDllMissing
  IfFileExists "$WINDIR\System32\vcruntime140_1.dll" 0 ffRuntimeDllMissing
  IfFileExists "$WINDIR\System32\msvcp140.dll" 0 ffRuntimeDllMissing
  ${EnableX64FSRedirection}
  SetRegView 64
  Call ffReadRuntimeVersion
  ${If} $ffRuntimeReady != "1"
    SetRegView 32
    Call ffReadRuntimeVersion
  ${EndIf}
  SetRegView 64
  Return
ffRuntimeDllMissing:
  ${EnableX64FSRedirection}
FunctionEnd

Function ffReadRuntimeVersion
  ReadRegDWORD $ffRuntimeInstalled HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegStr $ffRuntimeVersion HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
  ${If} $ffRuntimeInstalled == 1
  ${AndIf} $ffRuntimeVersion != ""
    StrCpy $ffRuntimeResult $ffRuntimeVersion 1
    ${If} $ffRuntimeResult == "v"
      StrCpy $ffRuntimeVersion $ffRuntimeVersion "" 1
    ${EndIf}
    ${VersionCompare} "$ffRuntimeVersion" "${FF_VC_MIN_VERSION}" $ffRuntimeResult
    ${If} $ffRuntimeResult == 0
    ${OrIf} $ffRuntimeResult == 1
      StrCpy $ffRuntimeReady "1"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function ffEnsureRuntime
  Call ffCheckRuntime
  ${If} $ffRuntimeReady == "1"
    Return
  ${EndIf}
  ; Silent updater installs also need the prerequisite. The Microsoft bootstrapper
  ; owns its UAC prompt; FlightFabric's installation scope is not changed.
  ${IfNot} ${Silent}
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "FlightFabric needs the Microsoft Visual C++ x64 runtime. Setup will install it now. Windows may ask for administrator permission. Your computer will not restart automatically." /SD IDCANCEL IDOK ffRuntimeContinue
    SetErrorLevel 1602
    Quit
  ${EndIf}
ffRuntimeContinue:
  InitPluginsDir
  SetOutPath $PLUGINSDIR
  File /oname=vc_redist.x64.exe "${PROJECT_DIR}\resources\vc-runtime\vc_redist.x64.exe"
  ${StdUtils.HashFile} $ffRuntimeResult "SHA2-256" "$PLUGINSDIR\vc_redist.x64.exe"
  ${If} $ffRuntimeResult != "${FF_VC_SHA256}"
    MessageBox MB_OK|MB_ICONSTOP "The Microsoft runtime installer could not be verified. Download FlightFabric Setup again." /SD IDOK
    SetErrorLevel 1603
    Quit
  ${EndIf}
  ClearErrors
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /passive /norestart' $ffRuntimeResult
  ${If} ${Errors}
    StrCpy $ffRuntimeResult "launch failed"
  ${EndIf}
  ${If} $ffRuntimeResult == 3010
  ${OrIf} $ffRuntimeResult == 1641
    MessageBox MB_OK|MB_ICONINFORMATION "Windows needs a restart to finish installing the Microsoft runtime. Restart when convenient, then run FlightFabric Setup again. FlightFabric has not been replaced." /SD IDOK
    SetErrorLevel 3010
    Quit
  ${EndIf}
  ${If} $ffRuntimeResult == 0
  ${OrIf} $ffRuntimeResult == 1638
    Call ffCheckRuntime
    ${If} $ffRuntimeReady == "1"
      Return
    ${EndIf}
  ${EndIf}
  MessageBox MB_OK|MB_ICONSTOP "Microsoft runtime setup did not complete (result: $ffRuntimeResult). FlightFabric has not been installed or replaced. Run Setup again and allow the Microsoft installation, or ask your administrator for help." /SD IDOK
  SetErrorLevel 1603
  Quit
FunctionEnd
!endif
!macroend

!macro customInit
  Call ffEnsureRuntime
!macroend
