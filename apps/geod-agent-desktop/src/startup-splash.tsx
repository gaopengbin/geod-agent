import { useEffect, useState } from "react";
import { t, useLocale } from "./i18n";
import "./startup-splash.css";

const splashDuration = 2000;

/** Per App mount, never replayed by sign-in, navigation or language changes. */
export function useStartupSplash() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), splashDuration);
    return () => window.clearTimeout(timer);
  }, []);
  return visible;
}

export function StartupSplash() {
  const locale = useLocale();
  return <section className="startup-splash" lang={locale} role="status" aria-label={t("欢迎使用 GeoD Agent")}>
    <div className="startup-grid" aria-hidden="true"/>
    <div className="startup-stars" aria-hidden="true"/>
    <div className="startup-content">
      <div className="startup-globe" aria-hidden="true">
        <div className="startup-globe-aura"/>
        <svg className="startup-orbits" viewBox="0 0 400 400" fill="none">
          <g className="startup-orbit-outer">
            <circle cx="200" cy="200" r="177" stroke="currentColor" strokeDasharray="3 13"/>
            <path d="M200 23 A177 177 0 0 1 375 175" stroke="#85ddff" strokeWidth="2"/>
            <circle cx="375" cy="175" r="3.5" fill="#b5eeff"/>
          </g>
          <ellipse cx="200" cy="200" rx="189" ry="64" transform="rotate(-28 200 200)" stroke="currentColor"/>
          <ellipse cx="200" cy="200" rx="189" ry="64" transform="rotate(48 200 200)" stroke="currentColor" opacity=".45"/>
          <circle className="startup-satellite" cx="200" cy="200" r="3.5" fill="#c7f4ff"/>
        </svg>
        <svg className="startup-sphere" viewBox="0 0 320 320" fill="none">
          <defs>
            <radialGradient id="startup-globe-fill" cx="35%" cy="28%" r="75%">
              <stop stopColor="#183f72" stopOpacity=".8"/>
              <stop offset="1" stopColor="#061324" stopOpacity=".8"/>
            </radialGradient>
            <clipPath id="startup-globe-clip"><circle cx="160" cy="160" r="119"/></clipPath>
          </defs>
          <circle cx="160" cy="160" r="120" fill="url(#startup-globe-fill)" stroke="#61c8ff" strokeOpacity=".65"/>
          <g clipPath="url(#startup-globe-clip)" stroke="#65c6ff" strokeOpacity=".32" transform="rotate(-18 160 160)">
            <ellipse cx="160" cy="160" rx="38" ry="119"/>
            <ellipse cx="160" cy="160" rx="84" ry="119"/>
            <path d="M41 160H279 M57 100Q160 150 263 100 M57 220Q160 170 263 220 M94 60Q160 92 226 60 M94 260Q160 228 226 260"/>
          </g>
          <path className="startup-scan" d="M47 130Q160 164 273 130" stroke="#8fe4ff" strokeWidth="1.5"/>
        </svg>
        <div className="startup-logo"><img src="/geod-agent-symbol-blue-violet.png" width="72" height="72" alt=""/></div>
      </div>
      <div className="startup-copy">
        <h1>{t("欢迎使用 GeoD Agent")}</h1>
        <p>{t("从对话出发，探索地理数据。")}</p>
      </div>
      <div className="startup-light" aria-hidden="true"><span/></div>
    </div>
    <div className="startup-caption" aria-hidden="true">{t("影像 · 矢量 · 三维")}</div>
  </section>;
}
