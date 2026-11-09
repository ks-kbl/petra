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
