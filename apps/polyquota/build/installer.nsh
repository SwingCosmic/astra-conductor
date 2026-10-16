# PolyQuota 安装器自定义逻辑（electron-builder 合并进生成的 NSIS 脚本）。
#
# 1. 全新机器不限制作用域：保留安装模式选择页，用户自选"为我 / 为所有人"；
# 2. 已有安装则锁定到之前的作用域与位置；
# 3. 历史污染清理：两个作用域同时存在注册信息时（旧版本跨作用域覆盖安装
#    所致），保留当前用户侧、静默卸载全机侧残留

!macro customInstallMode
  # 检测键与 initMultiUser 一致（INSTALL_REGISTRY_KEY 的 InstallLocation）：
  # 当前用户侧优先——双作用域并存时锁定到当前用户，配合 customInit 清理。
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $isForceCurrentInstall "1"
  ${Else}
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $0 != ""
      StrCpy $isForceMachineInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  # 双作用域并存（历史污染）：保留当前用户侧，静默卸载全机侧残留。
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} $1 != ""
    ReadRegStr $2 HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ${If} $2 != ""
      ReadRegStr $3 HKLM "${UNINSTALL_REGISTRY_KEY}" "InstallLocation"
      ${If} $3 == ""
        StrCpy $3 "$PROGRAMFILES\PolyQuota"
      ${EndIf}
      ExecWait '"$2" /S _?=$3'
    ${EndIf}
  ${EndIf}

  # 兜底清理残留快捷方式（当前用户与全机两个作用域）。
  SetShellVarContext current
  Delete "$SMPROGRAMS\PolyQuota.lnk"
  Delete "$DESKTOP\PolyQuota.lnk"
  SetShellVarContext all
  Delete "$SMPROGRAMS\PolyQuota.lnk"
  Delete "$DESKTOP\PolyQuota.lnk"
  SetShellVarContext current
!macroend
