import { useEffect, useId, useState } from "react";
import { Button } from "@/components/motion/button/base";
import { t } from "./i18n";
import { inputQuestions, validatedInputReply, type UserInputQuestion } from "./user-input";
import type {UserInputDraft} from './user-input-records';

const questionDrafts = new WeakMap<object, { page: number; values: Record<string,string>; custom: Record<string,boolean>; drafts: Record<string,string> }>();

export function UserInputQuestionCard({ questions: raw, respond, draft, onDraftChange }: { questions: unknown; respond: (value: unknown) => void | Promise<void>;draft?:UserInputDraft;onDraftChange?:(value:UserInputDraft)=>void }) {
  const key = raw && typeof raw === "object" ? raw : null;
  const saved = draft??(key ? questionDrafts.get(key) : undefined);
  const [page, setPage] = useState(saved?.page ?? 0);
  const [values, setValues] = useState<Record<string, string>>(saved?.values ?? {});
  const [custom, setCustom] = useState<Record<string, boolean>>(saved?.custom ?? {});
  const [drafts, setDrafts] = useState<Record<string, string>>(saved?.drafts ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const instance = useId();
  useEffect(() => {const value={page,values,custom,drafts};if (key) questionDrafts.set(key,value);onDraftChange?.(value);}, [key, page, values, custom, drafts]);
  let questions: UserInputQuestion[];
  try { questions = inputQuestions(raw); } catch (cause) { return <section className="codex-request-card" role="alert"><p>{t("问题格式无效，请取消后重试")}</p><Button variant="ghost" onClick={() => void respond({ answers: {} })}>{t("取消")}</Button></section>; }
  const current = questions[page];
  const filled = questions.every(question => !!values[question.id]?.trim());
  async function reply(cancel = false) {
    setBusy(true); setError("");
    try { await respond(cancel ? { answers: {} } : validatedInputReply(questions, { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [values[q.id]] }])) })); if (key) questionDrafts.delete(key); }
    catch (cause) { setError((cause as Error).message); setBusy(false); }
  }
  return <section className="user-input-card" role="region" aria-label={t("Agent 等待你的回复")}>
    <div className="user-input-heading"><strong>{t("补充需求")}</strong><span>{t("等待你的选择")}</span></div>
    {questions.length > 1 && <div className="user-input-tabs" role="tablist" aria-label={t("需求问题")}>
      {questions.map((question, index) => <button key={question.id} type="button" role="tab" id={`${instance}-tab-${index}`} aria-controls={`${instance}-panel`} aria-selected={page === index} tabIndex={page === index ? 0 : -1} onClick={() => setPage(index)} onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); const next = (index + (event.key === "ArrowRight" ? 1 : questions.length - 1)) % questions.length; setPage(next); document.getElementById(`${instance}-tab-${next}`)?.focus(); } }}><span className={values[question.id]?.trim() ? "answered" : ""}>{index + 1}</span>{question.header}</button>)}
    </div>}
    <div id={`${instance}-panel`} role={questions.length > 1 ? "tabpanel" : undefined} aria-labelledby={questions.length > 1 ? `${instance}-tab-${page}` : undefined}>
      <fieldset disabled={busy}><legend>{current.question}</legend>
        {current.options?.map(option => <label className="user-input-option" key={option.label}>
          <input type="radio" name={`${instance}-${current.id}`} checked={!custom[current.id] && values[current.id] === option.label} onChange={() => { setCustom(previous => ({ ...previous, [current.id]: false })); setValues(previous => ({ ...previous, [current.id]: option.label })); }}/>
          <span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
        </label>)}
        <label className="user-input-option user-input-custom"><input type="radio" name={`${instance}-${current.id}`} checked={!!custom[current.id] || !current.options?.length} onChange={() => { setCustom(previous => ({ ...previous, [current.id]: true })); setValues(previous => ({ ...previous, [current.id]: drafts[current.id] ?? "" })); }}/><span><b>{t("自定义回答")}</b></span></label>
        {(custom[current.id] || !current.options?.length) && (current.isSecret ? <input type="password" autoFocus maxLength={4000} aria-label={current.question} value={drafts[current.id] ?? ""} onChange={event => { const value=event.target.value; setDrafts(previous=>({...previous,[current.id]:value})); setValues(previous=>({...previous,[current.id]:value})); }}/> : <textarea autoFocus rows={2} maxLength={4000} aria-label={current.question} placeholder={t("输入你的具体要求…")} value={drafts[current.id] ?? ""} onChange={event => { const value = event.target.value; setDrafts(previous => ({ ...previous, [current.id]: value })); setValues(previous => ({ ...previous, [current.id]: value })); }}/>)}
      </fieldset>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="user-input-footer"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void reply(true)}>{t("取消本次操作")}</Button><div>
      {page > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPage(page - 1)}>{t("上一题")}</Button>}
      {page < questions.length - 1 ? <Button variant="outline" size="sm" disabled={busy || !values[current.id]?.trim()} onClick={() => setPage(page + 1)}>{t("下一题")}</Button> : <Button size="sm" disabled={busy || !filled} onClick={() => void reply()}>{busy ? t("正在提交…") : t("提交并继续")}</Button>}
    </div></div>
  </section>;
}
