!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Quieres desinstalar tambien Ollama?" IDNO skip_ollama

  DetailPrint "Desinstalando Ollama..."
  nsExec::ExecToLog 'cmd /C where winget >nul 2>nul && winget uninstall -e --id Ollama.Ollama --silent --disable-interactivity --accept-source-agreements --accept-package-agreements'
  Pop $0
  DetailPrint "winget uninstall exit code: $0"

  IfFileExists "$LOCALAPPDATA\Programs\Ollama\Uninstall Ollama.exe" 0 +4
    DetailPrint "Ejecutando desinstalador local de Ollama..."
    ExecWait '"$LOCALAPPDATA\Programs\Ollama\Uninstall Ollama.exe" /S' $1
    DetailPrint "Uninstall Ollama.exe exit code: $1"

  MessageBox MB_YESNO|MB_ICONEXCLAMATION "Quieres borrar tambien los modelos de Ollama (~/.ollama)?" IDNO skip_models
  DetailPrint "Borrando modelos de Ollama en $PROFILE\.ollama"
  RMDir /r "$PROFILE\.ollama"

skip_models:
skip_ollama:
!macroend
