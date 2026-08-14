; Uninstall cleanup beyond the file tree.
;
; The app registers itself for launch at sign-in through the HKCU Run key, which lives outside the
; install directory and so survives an ordinary uninstall. Left behind, Windows would try to start a
; deleted executable at every sign-in. The value name matches AUTO_START_KEY in
; src/main/settingsStore.ts.

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dynamic Wallpaper"
!macroend
