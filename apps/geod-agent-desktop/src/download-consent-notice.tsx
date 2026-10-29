import{Button}from '@/components/motion/button/base';
import{t}from './i18n';
import './download-consent-notice.css';
export function DownloadConsentNotice({busy,onDecide}:{busy:boolean;onDecide:(enabled:boolean)=>Promise<void>}){
 return <section className="download-consent-notice" role="status" aria-label={t('下载诊断统计')}>
  <p>{t('是否允许发送下载结果和脱敏诊断，帮助排查失败原因？')}</p>
  <small>{t('关联当前账号，发送图源服务、底图与注记、HTTP 状态、失败阶段和空间数值。不含密钥、坐标、文件名或完整路径；可随时关闭，不影响下载。')}</small>
  <div><Button size="sm" variant="secondary" disabled={busy} onClick={()=>void onDecide(true)}>{t('允许发送诊断')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void onDecide(false)}>{t('暂不开启')}</Button></div>
 </section>;
}
