import { ChevronDown, CircleAlert, Network } from "./icons";
import { localize, t } from "./i18n";
import type { RegisteredPluginApp } from "./api";

/** Registered IDs describe a service; only an actual bundled connector can be invoked here. */
export function PluginRegisteredApps({ apps, compact = false }: { apps?: RegisteredPluginApp[]; compact?: boolean }) {
  if (!apps?.length) return null;
  return <div className={`plugin-registered-apps${compact ? " is-compact" : ""}`}>
    {!compact && <h3>{t("应用声明")}</h3>}
    {apps.map(app => <details className="plugin-registered-app" key={`${app.name}:${app.registeredId}`}>
      <summary>
        {app.route === "bundledMcp" ? <Network size={14} /> : <CircleAlert size={14} />}
        <span>{app.name}</span>
        <small>{app.route === "bundledMcp" ? t("随包工具服务") : t("需要账号通道")}</small>
        <ChevronDown size={13} />
      </summary>
      <p>{app.route === "bundledMcp" ? t("使用插件自带的工具服务。注册应用的 OpenAI 账号通道尚未接入。") : localize(app.reason || t("此注册应用需要 OpenAI 账号通道，当前 GeoD 尚未接入"))}</p>
      <code>{app.registeredId}</code>
    </details>)}
  </div>;
}
