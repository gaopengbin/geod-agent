export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isSecret?: boolean;
  options?: { label: string; description: string }[];
}
export interface UserInputReply { answers: Record<string, { answers: string[] }> }

export function inputQuestions(raw: unknown): UserInputQuestion[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new Error("问题数量需要为 1–3 个");
  const ids = new Set<string>();
  return raw.map(value => {
    if (!value || typeof value !== "object") throw new Error("问题格式无效");
    const row = value as Record<string, unknown>;
    const text = (v: unknown, limit: number) => typeof v === "string" && v.trim() && v.length <= limit ? v.trim() : "";
    const id = text(row.id, 80), question = text(row.question, 1000);
    if (!id || ids.has(id) || !question) throw new Error("问题内容或标识无效");
    ids.add(id);
    let options: UserInputQuestion["options"];
    if (row.options != null) {
      if (!Array.isArray(row.options) || row.options.length > 5) throw new Error("选项格式无效");
      const labels = new Set<string>();
      options = row.options.map(option => {
        const label = text(option?.label, 300);
        if (!label || labels.has(label)) throw new Error("选项重复或为空");
        labels.add(label);
        return { label, description: text(option?.description, 600) };
      });
    }
    return { id, header: text(row.header, 40) || "补充信息", question, options, isSecret: row.isSecret === true };
  });
}

export function validatedInputReply(questions: UserInputQuestion[], value: unknown): UserInputReply | null {
  const answers = (value as UserInputReply | null)?.answers;
  if (!answers || typeof answers !== "object" || !Object.keys(answers).length) return null;
  const result: UserInputReply = { answers: {} };
  for (const question of questions) {
    const answer = answers[question.id]?.answers;
    if (!Array.isArray(answer) || answer.length !== 1 || typeof answer[0] !== "string" || !answer[0].trim() || answer[0].length > 4000) throw new Error("请回答所有问题后提交");
    result.answers[question.id] = { answers: [answer[0].trim()] };
  }
  return result;
}

const temporalQuestion = /年份|年代|年[份度]?|日期|时间|时期|时相|季节|月份|period|date|year|season|time/i;
/** Only direct human requests can opt out; quoted examples and tool output cannot. */
export function clarificationPreference(text: string): "ask" | "delegate" | "delegate-period" | undefined {
  const humanText = text.split(/\n已附加边界：/)[0];
  const direct = humanText.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'/g, " ");
  if (/先(?:问我|问用户|询问我|询问用户|征求我的)|有(?:疑问|歧义|不明确).*(?:问我|问用户|询问)|不要(?:替我|替用户|代我|自行|自己)(?:决定|选择)|(?:ask|check with) me first|do not decide for me/i.test(direct)) return "ask";
  if (/如果|除非|unless|\bif\b/i.test(direct)) return undefined;
  const decision = "(?:你(?:来|自己|自行)?(?:决定|选择|定)|(?:不要|不用|别)(?:再)?(?:问我|询问我))";
  if (new RegExp(`(?:时期|年份|日期|时间|时相|季节)[^，,。；;！？!?]{0,20}${decision}|${decision}[^，,。；;！？!?]{0,10}(?:时期|年份|日期|时间|时相|季节)`).test(direct)) return "delegate-period";
  if (new RegExp(`(?:格式|图源|范围|分辨率|缩放|合并|拆分)[^，,。；;！？!?]{0,20}${decision}|${decision}[^，,。；;！？!?]{0,10}(?:格式|图源|范围|分辨率|缩放|合并|拆分)`).test(direct)) return undefined;
  if (/(?:不要|不用|无需|不必|别)(?:再)?(?:向我)?(?:询问(?:我|用户)?|问(?:我|用户)?|提问)(?:了|吧)?(?=$|[，,。；;！!\s])|(?:^|[，,。；;！!\s])(?:请|就|那就|由)?你(?:来|自己|自行)?(?:决定|选择)(?:吧|即可|就好)?(?=$|[，,。；;！!\s])|(?:全部|都)(?:用|按)默认(?:值|参数|设置)|(?:^|[，,。；;！!\s])(?:请|就|直接)?(?:用|按)默认(?:值|参数|设置)(?=$|[，,。；;！!\s])|(?:do not|don't|dont) ask(?: me)?|(?:decide|choose) (?:for me|yourself)|use (?:the )?default(?:s| settings| parameters)/i.test(direct)) return "delegate";
  return undefined;
}
export function missingHistoricalPeriod(text: string): boolean {
  return /历史|往年|旧版|historical|historic|past imagery/i.test(text) &&
    !/(?:19|20)\d{2}|去年|前年|今年|上个月|最近|最新|last year|this year|latest|most recent/i.test(text);
}

/** Per-conversation turn gate: never execute stale sibling calls after an answer. */
export class UserInputGate {
  get allowsChoices() { return this.delegated; }
  waiting = false;
  cancelled = false;
  private stale = false;
  private needsPeriod = false;
  private delegated = false;
  private delegatedPeriod = false;
  reset(text: string, previousRequests?: string[]) {
    if (previousRequests) { this.delegated = false; this.delegatedPeriod = false; }
    for (const request of [...(previousRequests ?? []), text]) {
      const preference = clarificationPreference(request);
      if (preference === "ask") { this.delegated = false; this.delegatedPeriod = false; }
      else if (preference === "delegate") { this.delegated = true; this.delegatedPeriod = true; }
      else if (preference === "delegate-period") this.delegatedPeriod = true;
    }
    this.waiting = false; this.cancelled = false; this.stale = false;
    this.needsPeriod = !this.delegatedPeriod && missingHistoricalPeriod(text);
  }
  begin() { this.waiting = true; }
  finish(questions: UserInputQuestion[], reply: UserInputReply | null) {
    this.waiting = false; this.stale = true;
    if (!reply) this.cancelled = true;
    else if (questions.some(q => temporalQuestion.test(q.header + " " + q.question))) this.needsPeriod = false;
  }
  freshModelRound() { if (!this.waiting) this.stale = false; }
  finishDependency(accepted: boolean) { this.waiting = false; this.stale = true; if (!accepted) this.cancelled = true; }
  block(name: string): { error: string; message: string } | null {
    if (this.cancelled) return { error: "USER_INPUT_CANCELLED", message: "用户已取消补充信息。停止本次操作，不选用默认答案。" };
    if (this.waiting) return { error: "USER_INPUT_PENDING", message: "等待用户回答问答卡，暂不执行后续工具。" };
    if (this.stale) return { error: "REPLAN_AFTER_USER_INPUT", message: "用户刚提交答案。请在新一轮模型请求中读取答案后重新决定操作，不执行之前生成的参数。" };
    if (this.delegated && name === "ask_user") return { error: "USER_DELEGATED_CHOICES", message: "用户已明确授权自行决定或不要询问。仅在授权范围内选择可用方案，并说明假设；不要代填用户答案。" };
    if (this.needsPeriod && /^(plan_imagery|plan_imagery_batch|jobs_start|data_download_plan|data_download_start)$/.test(name)) return {
      error: "HISTORICAL_PERIOD_REQUIRED", message: "用户尚未指定历史影像的年份或时期。先调用 ask_user 确认时间要求，再检查可用版本和采集日期；已登记版本不是用户选择。",
    };
    return null;
  }
}
