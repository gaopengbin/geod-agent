import { useEffect, useState } from "react";
import { t, useLocale } from "./i18n";
import markup from './startup-markup.html?raw';
import "./startup-splash.css";

interface StartupBoot { ready:Promise<void>;startedAt:number;finish:()=>Promise<void> }
declare global { interface Window { __GEOD_STARTUP__?:StartupBoot } }
export const remainingStartupTime=(startedAt:number,now:number)=>Math.max(0,2000-Math.max(0,now-startedAt));

/** The early HTML screen remains mounted while React and records initialize. */
export function useStartupSplash() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const boot=window.__GEOD_STARTUP__;
    const begin=()=>{
      if(disposed)return;
      timer=setTimeout(async()=>{
        if(boot)await boot.finish();
        if(!disposed)setVisible(false);
      },boot?remainingStartupTime(boot.startedAt,performance.now()):2000);
    };
    if(boot)void boot.ready.then(begin);else begin();
    return()=>{disposed=true;clearTimeout(timer);};
  }, []);
  return visible;
}

const escaped=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function StartupSplash() {
  const locale=useLocale();
  if(document.getElementById('geod-startup-boot'))return null;
  const html=markup.replace('欢迎使用 GeoD Agent',escaped(t('欢迎使用 GeoD Agent'))).replace('从对话出发，探索地理数据。',escaped(t('从对话出发，探索地理数据。'))).replace('影像 · 矢量 · 三维',escaped(t('影像 · 矢量 · 三维')));
  return <section className="startup-splash" lang={locale} role="status" aria-label={t('欢迎使用 GeoD Agent')} dangerouslySetInnerHTML={{__html:html}}/>;
}
