; 只自定义 MUI 页面文案。WebView2、安装目录、维护和更新流程仍由 Tauri 管理。
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 Petra"
!define MUI_WELCOMEPAGE_TEXT "把你的 AI 助手带到桌面上。$\r$\n$\r$\n点击「下一步」继续。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择 Petra 的程序安装位置。点击「浏览」可以选择其他文件夹。"
!define MUI_FINISHPAGE_TITLE "Petra 安装完成"
!define MUI_FINISHPAGE_TEXT "现在可以启动 Petra。"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Petra"

; Petra：sherpa-onnx 的 DLL 是资源的子目录（dlls\），但 Windows 只在 exe 同级目录找 DLL，
; 所以安装完后把它们复制到 $INSTDIR 根目录。卸载时一并清理。
!macro NSIS_HOOK_POSTINSTALL
  CopyFiles /SILENT "$INSTDIR\dlls\*.dll" "$INSTDIR"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\cargs.dll"
  Delete "$INSTDIR\onnxruntime.dll"
  Delete "$INSTDIR\onnxruntime_providers_shared.dll"
  Delete "$INSTDIR\sherpa-onnx-c-api.dll"
  Delete "$INSTDIR\sherpa-onnx-cxx-api.dll"
!macroend
