import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/motion/button/base";
import { UiSelect } from "./ui-select";
import { X } from "./icons";
import { t, useLanguagePreferences, setLanguagePreferences, type LanguagePreference, type ReplyLanguage } from "./i18n";

export const LANGUAGE_OPEN = "geod-language-open";

export function LanguageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const preferences = useLanguagePreferences();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="permission-dialog-overlay"/>
    <Dialog.Content className="permission-dialog language-dialog">
      <div className="dialog-heading"><Dialog.Title>{t("语言")}</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="icon" aria-label={t("关闭")}><X size={17}/></Button></Dialog.Close></div>
      <Dialog.Description>{t("语言设置保存在此设备，切换后立即生效。")}</Dialog.Description>
      <label>{t("界面语言")}<UiSelect ariaLabel={t("界面语言")} value={preferences.language} onValueChange={value => setLanguagePreferences({language:value as LanguagePreference})} options={[
        {value:"auto",label:t("跟随系统")},{value:"zh-CN",label:"简体中文"},{value:"en",label:"English"},
      ]}/></label>
      <label>{t("AI 回复语言")}<UiSelect ariaLabel={t("AI 回复语言")} value={preferences.replyLanguage} onValueChange={value => setLanguagePreferences({replyLanguage:value as ReplyLanguage})} options={[
        {value:"auto",label:t("跟随输入语言")},{value:"interface",label:t("跟随界面语言")},{value:"zh-CN",label:"简体中文"},{value:"en",label:"English"},
      ]}/></label>
      <p className="memory-footnote">{t("日期、数字和界面提示使用所选语言；已保存的对话与数据名称保持原文。")}</p>
      <div className="permission-dialog-actions"><Dialog.Close asChild><Button>{t("完成")}</Button></Dialog.Close></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
