import {useId,useState} from 'react';
import {Button} from '@/components/motion/button/base';
import {ChevronDown,ExternalLink,ShieldCheck} from './icons';
import {t} from './i18n';
import './own-channel-guide.css';

export function OwnChannelGuide({onConfigure}:{onConfigure?:()=>void}){
 const [expanded,setExpanded]=useState(false);const id=useId();
 return <section className="own-channel-guide" aria-label={t('自有模型渠道')}>
  <div className="own-channel-guide-heading"><ShieldCheck size={18}/><div><h3>{t('也可以使用自己的模型渠道')}</h3><p>{t('自有渠道不扣 GeoD Credits，模型费用由对应服务商结算。')}</p></div></div>
  <div className="own-channel-guide-actions"><Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(!expanded)}><ChevronDown size={14} className={expanded?'own-channel-guide-chevron-open':''}/>{expanded?t('收起教程'):t('查看配置教程')}</Button>{onConfigure&&<Button size="sm" variant="outline" onClick={onConfigure}><ExternalLink size={14}/>{t('打开模型与渠道')}</Button>}</div>
  <div id={id} hidden={!expanded} className="own-channel-guide-body">
   <ol>
    <li><strong>{t('准备 API Key')}</strong><p>{t('在你选择的模型服务商后台开通 API，并取得 API Key。网页版会员不一定包含 API 额度。')}</p></li>
    <li><strong>{t('添加渠道')}</strong><p>{t('打开左侧“模型与渠道”，点击“添加渠道”。选择服务预设，或填写服务商给出的 API 基础地址与接口类型，再粘贴 API Key。')}</p><p>{t('例如 DeepSeek：选择 DeepSeek 预设，基础地址为 https://api.deepseek.com/v1，接口类型为 Chat Completions。')}</p></li>
    <li><strong>{t('选择实际可用的模型')}</strong><p>{t('点击“读取模型目录”，从返回的目录添加模型；若服务不提供目录，可按服务商文档手动填写模型 ID。模型需支持工具调用；上下文和输出上限按服务商规格填写。然后点击“保存渠道”。')}</p></li>
    <li><strong>{t('在对话中切换渠道')}</strong><p>{t('在输入框右下角的模型选择器中选择你的渠道和模型，先发一句简短消息验证。也可以设置“新对话默认模型”；已有会话与定时任务保留原选择，需要分别切换。')}</p></li>
   </ol>
   <p className="own-channel-guide-note">{t('API Key 保存在本机系统凭据中。自有渠道的用量在应用内单独记录，余额和费用请到服务商后台查看。连接失败时核对基础地址、接口类型、模型 ID、API 余额和网络代理。')}</p>
  </div>
 </section>;
}
