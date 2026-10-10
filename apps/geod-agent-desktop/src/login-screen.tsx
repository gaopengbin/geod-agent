import type { ReactNode } from "react";
import { Button } from "@/components/motion/button/base";
import { Globe2, Moon, Network, Sun } from "./icons";
import { t, useLocale } from "./i18n";
import "./login-screen.css";

/** A dedicated account entry surface; authentication controls come from the real flow. */
export function LoginScreen({ children, inert, theme, onNetwork, onLanguage, onTheme }: {
  children: ReactNode;
  inert?: boolean;
  theme: "light" | "dark";
  onNetwork: () => void;
  onLanguage: () => void;
  onTheme: () => void;
}) {
  useLocale();
  return <main className="login-screen" inert={inert} aria-labelledby="login-heading">
    <section className="login-content">
      <img className="login-symbol" src="/geod-agent-symbol-blue-violet.png" alt="" width={56} height={56}/>
      <h1 id="login-heading">{t("欢迎使用 GeoD Agent")}</h1>
      <p className="login-summary">{t("用自然语言，获取你需要的地理数据。")}</p>
      <div className="login-controls">{children}</div>
    </section>
    <footer className="login-footer" aria-label={t("登录页设置")}>
      <Button variant="ghost" size="sm" whileHover={undefined} onClick={onNetwork}><Network size={16} aria-hidden="true"/>{t("网络与代理")}</Button>
      <span className="login-footer-divider" aria-hidden="true"/>
      <Button variant="ghost" size="sm" whileHover={undefined} onClick={onLanguage}><Globe2 size={16} aria-hidden="true"/>{t("语言")}</Button>
      <span className="login-footer-divider" aria-hidden="true"/>
      <Button variant="ghost" size="sm" whileHover={undefined} onClick={onTheme}>{theme === "dark" ? <Sun size={16} aria-hidden="true"/> : <Moon size={16} aria-hidden="true"/>}{theme === "dark" ? t("浅色外观") : t("深色外观")}</Button>
    </footer>
  </main>;
}
