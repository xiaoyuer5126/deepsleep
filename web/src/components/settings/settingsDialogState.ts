import { create } from 'zustand'
import { canChat, useAuth } from '../../services/auth.js'

/** 设置弹窗的分组：通用设置 / 账号 / 数据管理 */
export type SettingsSection = 'general' | 'account' | 'data'

/** 设置弹窗：侧边栏底部、账号菜单都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 账号没有可用 API Key 时打开「账号」分组并返回 false，引导用户先绑定。 */
export const ensureChatReady = () => {
  if (canChat(useAuth.getState().user, useAuth.getState().config)) {
    return true
  }
  openSettings('account')
  return false
}
