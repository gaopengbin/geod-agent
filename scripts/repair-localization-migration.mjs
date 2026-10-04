import fs from 'node:fs';
import path from 'node:path';
const root='apps/geod-agent-desktop/src';
for(const file of fs.readdirSync(root).filter(file=>file.endsWith('.tsx'))){
  const target=path.join(root,file);let text=fs.readFileSync(target,'utf8');
  if(text.includes('from "./i18n"'))text=text.replace(/(\.toLocale\w+\()["']zh-CN["']/g,'$1getLocale()');
  if(file==='unified-task-queue-view.tsx')text=text.replace(/import \{ getLocale, t, localize \}/,'import { getLocale, t as tr, localize }').replace(/\bt\("/g,'tr("');
  fs.writeFileSync(target,text);
}
const file=path.join(root,'locales/en.json'),value=JSON.parse(fs.readFileSync(file,'utf8'));
Object.assign(value,{
  '语言':'Language','关闭':'Close','界面语言':'Interface language','AI 回复语言':'AI reply language',
  '跟随系统':'System default','跟随输入语言':'Match input language','跟随界面语言':'Match interface language',
  '语言设置保存在此设备，切换后立即生效。':'Language preferences are saved on this device and apply immediately.',
  '日期、数字和界面提示使用所选语言；已保存的对话与数据名称保持原文。':'Dates, numbers and interface messages use the selected language. Saved conversations and data names keep their original text.',
  '搜索会话':'Search conversations','会话历史':'Conversation history','搜索标题或对话内容':'Search titles or conversation text',
  '全部会话':'All conversations','已归档':'Archived','导入会话':'Import conversation','导出会话':'Export conversation',
  '置顶':'Pin','取消置顶':'Unpin','归档':'Archive','取消归档':'Unarchive','删除会话':'Delete conversation',
  '会话名称':'Conversation name','重命名会话':'Rename conversation','没有匹配的会话':'No matching conversations',
  '加载更多':'Load more','删除本机对话记录？':'Delete this local conversation?',
  '成果文件和已启动的下载任务可继续在任务区管理。':'You can manage output files and downloads already started in the task panel.',
  '停止回复后可以删除此会话。':'Stop the reply before deleting this conversation.',
  '已导入会话':'Conversation imported','已导出会话':'Conversation exported',
  'JSON 文件保留文字历史，可重新导入；Markdown 适合阅读和分享。':'JSON preserves text history for importing again. Markdown is suitable for reading and sharing.',
  '正在运行':'Running','全部':'All','默认工作区':'Default workspace',
});
fs.writeFileSync(file,JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))),null,2)+'\n');
