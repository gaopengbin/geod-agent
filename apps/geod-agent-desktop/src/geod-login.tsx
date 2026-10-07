import { Button } from "@/components/motion/button/base";
import { desktopAvailable } from "./api";
import type { GeoDAuth } from "./geod-auth";
import { CircleAlert, ExternalLink, Loader2, RefreshCw } from "./icons";
import { localize, t } from "./i18n";

export function GeoDLogin({ auth }: { auth: GeoDAuth }) {
  const { status, ready, busy } = auth;
  const waiting = status.state === "waiting";
  const checking = !ready || busy === "refresh";
  const unavailable = ready && status.state === "unconfigured";
  const error = auth.error || status.error;
  return <>
    <Button className="login-primary-action" size="lg" whileHover={undefined} onClick={() => void auth.begin()}
      disabled={!desktopAvailable || checking || !!busy || waiting || unavailable}>
      {checking || busy === "login" || waiting ? <Loader2 size={18} className="login-spinner" aria-hidden="true"/> : <ExternalLink size={18} aria-hidden="true"/>}
      {checking ? t("正在检查登录状态…") : busy === "login" ? t("正在打开浏览器…") : waiting ? t("等待浏览器授权…") : t("使用 GeoD 账号登录")}
    </Button>
    <div className="login-status" role="status" aria-live="polite">
      {!desktopAvailable ? t("当前为界面预览，请在桌面应用中登录。") : checking ? t("正在读取已保存的登录信息。") : waiting ? t("请在浏览器中完成登录和授权，完成后会自动进入应用。") : unavailable && auth.error ? t("暂时无法读取登录状态，请重新检查。") : unavailable ? t("登录服务尚未配置，暂时无法登录。") : t("将在浏览器中打开登录页，授权完成后自动返回。")}
    </div>
    {error && <div className="login-error" role="alert"><CircleAlert size={17} aria-hidden="true"/><p>{localize(error)}</p></div>}
    {desktopAvailable && ready && (waiting || error || unavailable) && <Button className="login-recheck" variant="ghost" size="sm" whileHover={undefined} disabled={!!busy} onClick={() => void auth.refresh()}><RefreshCw size={15} aria-hidden="true"/>{t("重新检查登录状态")}</Button>}
  </>;
}
