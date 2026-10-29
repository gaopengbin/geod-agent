import{Button}from '@/components/motion/button/base';
import{t}from './i18n';
import './download-consent-notice.css';
export function DownloadConsentNotice({busy,downloadEnabled,activityEnabled,onAcknowledge,onDisable}:{busy:boolean;downloadEnabled:boolean;activityEnabled:boolean|null;onAcknowledge:()=>Promise<void>;onDisable:()=>Promise<void>}){
 return <section className="download-consent-notice" role="status" aria-label={t('下载诊断统计')}>
  <p>{t('基础诊断与使用统计默认开启，可随时关闭。')}</p>
  <small>{t('关联当前账号，记录启动、调用结果和可用用量，以及图源服务、底图与注记、HTTP 状态、失败阶段和空间数值。不发送对话、密钥、坐标、文件名或完整路径；明确关闭的选择会保留。')}</small>
  <small>{t('下载诊断：')}{downloadEnabled?t('已开启'):t('已关闭')}{' · '}{t('使用统计：')}{activityEnabled===null?t('正在读取…'):activityEnabled?t('已开启'):t('已关闭')}</small>
  <div><Button size="sm" variant="secondary" disabled={busy} onClick={()=>void onAcknowledge()}>{t('知道了')}</Button><Button size="sm" variant="outline" disabled={busy||(!downloadEnabled&&!activityEnabled)} onClick={()=>void onDisable()}>{t('关闭统计')}</Button></div>
 </section>;
}
