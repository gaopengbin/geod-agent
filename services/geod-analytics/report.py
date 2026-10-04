"""GeoD-only, read-only operational report. Python standard library only."""
import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import html
import json
from pathlib import Path
import sqlite3
import sys

BJ = timezone(timedelta(hours=8))
DEFAULT_PATHS = {
    "accounts": "/srv/laogao/data/geod-studio/accounts/store.json",
    "desktop": "/srv/laogao/data/geod-telemetry/geod-telemetry-v2.sqlite",
    "website": "/srv/laogao/data/platform-api/platform-api.sqlite",
    "agent": "/srv/laogao/data/geod-agent/agent-model.sqlite",
}


def timestamp(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Timestamp must include a timezone")
    return result


@contextmanager
def readonly_database(path, tables):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    # In particular, the platform DB must never expose accounts, payments or
    # WeChat tables to this report. Restrict reads, even if a query is changed.
    def authorize(action, table, column, database, source):
        if action == sqlite3.SQLITE_READ and table not in tables:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    connection.set_authorizer(authorize)
    try:
        yield connection
    finally:
        connection.close()


def rows(connection, sql, parameters=()):
    return [dict(row) for row in connection.execute(sql, parameters)]


def first(connection, sql, parameters=()):
    return rows(connection, sql, parameters)[0]


def latest_bj(value):
    return timestamp(value).astimezone(BJ).isoformat(timespec="seconds") if value else None


AUDIENCES = ('internal', 'external', 'unknown')


def audience(value):
    return value if value in AUDIENCES else 'unknown'


def auth_report(store, start, until):
    audit = store.get('authAudit')
    if not audit or audit.get('version') != 1 or timestamp(audit['startedAt']) >= until:
        return {'status': 'not_instrumented', 'counts': None}
    events = [event for event in audit['events'] if start <= timestamp(event['occurredAt']) < until]
    labels = {user['id']: audience(user.get('analyticsAudience')) for user in store['users']}
    counts = Counter((event['action'], event['outcome'], event['channel'], event['mode'], labels.get(event.get('userId'), audience(event.get('audience')))) for event in events)
    failure_reasons = Counter((event['action'], event.get('reason', 'OTHER')) for event in events if event['outcome'] == 'failure')
    return {'status': 'recording', 'started_at_bj': latest_bj(audit['startedAt']),
            'retained_from_bj': latest_bj(audit['events'][0]['occurredAt']) if audit['events'] else latest_bj(audit['startedAt']),
            'counts': [{'action': key[0], 'outcome': key[1], 'channel': key[2], 'mode': key[3], 'audience': key[4], 'events': count}
                       for key, count in sorted(counts.items())],
            'failure_reasons': [{'action': key[0], 'reason': key[1], 'events': count} for key,count in sorted(failure_reasons.items())]}


def download_report(records, started_at, start, until):
    if not started_at or timestamp(started_at) >= until:
        return {'status': 'not_instrumented', 'counts': None}
    # Join only random attempts within each source identity, then discard all IDs.
    starts, outcomes = {}, {}
    for record in sorted(records, key=lambda row: timestamp(row['occurred_at'])):
        at = timestamp(record['occurred_at'])
        if at >= until:
            continue
        props = record['properties']
        if props.get('state') not in ('started', 'completed', 'completed_with_gaps', 'partial', 'failed', 'cancelled'):
            continue
        key = (record['identity'], props.get('attempt_id'))
        if not key[1]:
            continue
        if props['state'] == 'started':
            starts.setdefault(key, at)
        else:
            outcomes[key] = (at, props)
    cohort = {key for key, at in starts.items() if start <= at < until}
    counts = Counter(props['state'] for at, props in outcomes.values() if start <= at < until)
    durations = Counter(props.get('duration', 'unknown') for at, props in outcomes.values() if start <= at < until)
    reasons = Counter(props.get('reason', 'unknown') for at, props in outcomes.values() if start <= at < until and props['state'] in ('failed', 'partial', 'completed_with_gaps'))
    cohort_results = Counter(outcomes[key][1]['state'] if key in outcomes else 'pending' for key in cohort)
    return {'status': 'recording', 'started_at_bj': latest_bj(started_at), 'observed_starts': len(cohort),
            'counts': dict(counts), 'durations': dict(durations), 'failure_reasons': dict(reasons),
            'start_cohort_results': dict(cohort_results),
            'complete_rate': cohort_results['completed'] / len(cohort) if cohort else None}


def identity_report(path, start, until):
    store = json.loads(Path(path).read_text(encoding="utf-8"))
    # Never serialize the store, email, password hashes, tokens, or user IDs.
    users = store["users"]
    sessions = store["sessions"]
    if not isinstance(users, list) or not isinstance(sessions, list):
        raise ValueError("Invalid GeoD identity schema")
    users = [row for row in users if timestamp(row["createdAt"]) < until]
    ids = {row["id"] for row in users}
    if len(ids) != len(users):
        raise ValueError("Duplicate GeoD account ID")
    sessions = [row for row in sessions
                if row["userId"] in ids and timestamp(row["createdAt"]) < until]
    new_users = [row for row in users if timestamp(row["createdAt"]) >= start]
    recent_sessions = [row for row in sessions if timestamp(row["createdAt"]) >= start]
    grants = [row for row in store.get("geodOAuthGrants", [])
              if row["userId"] in ids and row.get("clientId") == "geod-agent-desktop"]
    registration_days = Counter(timestamp(row["createdAt"]).astimezone(BJ).date().isoformat()
                                for row in new_users)
    session_days = Counter(timestamp(row["createdAt"]).astimezone(BJ).date().isoformat()
                           for row in recent_sessions)
    last_registered = max((row["createdAt"] for row in users), key=timestamp, default=None)
    last_session = max((row["createdAt"] for row in sessions), key=timestamp, default=None)
    return {
        "audience_accounts": {kind: sum(audience(row.get('analyticsAudience')) == kind for row in users) for kind in AUDIENCES},
        "auth_audit": auth_report(store, start, until),
        "total_accounts": len(users),
        "verified_accounts": sum(bool(row.get("emailVerifiedAt")) for row in users),
        "new_accounts": len(new_users),
        "retained_sessions_in_window": len(recent_sessions),
        "accounts_with_new_session": len({row["userId"] for row in recent_sessions}),
        "accounts_with_valid_retained_session": len({row["userId"] for row in sessions
                                                     if timestamp(row["expiresAt"]) > until}),
        "accounts_with_retained_agent_grant": len({row["userId"] for row in grants}),
        "last_registered_bj": latest_bj(last_registered),
        "last_session_created_bj": latest_bj(last_session),
        "daily": [{"day": day, "new_accounts": registration_days[day],
                   "retained_sessions_created": session_days[day]}
                  for day in sorted(set(registration_days) | set(session_days))],
    }


def event_report(path, start, until, website=False):
    table, identity = ("product_events", "visitor_id") if website else ("events", "install_id")
    # Product filtering is mandatory; there is deliberately no product option.
    product_filter = "product = 'geod-web' AND " if website else ""
    predicate = product_filter + "julianday(occurred_at) >= julianday(?) AND julianday(occurred_at) < julianday(?)"
    parameters = (start.isoformat(), until.isoformat())
    with readonly_database(path, {table, 'telemetry_metadata'} if not website else {table}) as connection:
        summary = first(connection, f"SELECT count(*) events, count(distinct {identity}) anonymous_ids, "
                        f"count(distinct session_id) sessions FROM {table} WHERE {predicate}", parameters)
        summary["last_event_bj"] = latest_bj(first(connection,
            f"SELECT max(occurred_at) latest FROM {table} WHERE {product_filter}julianday(occurred_at) < julianday(?)",
            (until.isoformat(),))["latest"])
        summary["last_received_bj"] = latest_bj(first(connection,
            f"SELECT max(received_at) latest FROM {table} WHERE {product_filter}julianday(received_at) < julianday(?)",
            (until.isoformat(),))["latest"])
        summary["daily"] = rows(connection,
            f"SELECT date(occurred_at,'+8 hours') day,count(*) events,count(distinct {identity}) anonymous_ids "
            f"FROM {table} WHERE {predicate} GROUP BY day ORDER BY day", parameters)
        summary["event_counts"] = rows(connection,
            f"SELECT event_name,count(*) events,count(distinct {identity}) anonymous_ids FROM {table} "
            f"WHERE {predicate} GROUP BY event_name ORDER BY events DESC", parameters)
        if website:
            summary["download_failure_reasons"] = rows(connection,
                f"SELECT coalesce(json_extract(properties_json,'$.reason'),'unknown') reason,count(*) events "
                f"FROM {table} WHERE {predicate} AND event_name='browser_download_failed' GROUP BY reason", parameters)
        else:
            metadata_rows = rows(connection, "SELECT value FROM telemetry_metadata WHERE key='download_lifecycle_started_at'") if connection.execute("PRAGMA table_info(telemetry_metadata)").fetchall() else []
            metadata = metadata_rows[0]['value'] if metadata_rows else None
            lifecycle = rows(connection, "SELECT install_id identity,occurred_at,properties_json FROM events WHERE event_name='download_task_state' AND julianday(occurred_at)>=julianday(?) AND julianday(occurred_at)<julianday(?)", parameters)
            summary['downloads'] = download_report([dict(row, properties=json.loads(row['properties_json'])) for row in lifecycle], metadata, start, until)
            summary["download_workflows"] = rows(connection,
                f"SELECT coalesce(json_extract(properties_json,'$.workflow'),'unknown') workflow,count(*) tasks "
                f"FROM {table} WHERE {predicate} AND event_name='download_task_created' GROUP BY workflow", parameters)
        return summary


def agent_report(path, start, until, labels=None):
    labels = labels or {}
    with readonly_database(path, {"model_generations", "agent_events", "agent_event_metadata"}) as connection:
        parameters = (start.isoformat(), until.isoformat())
        predicate = "julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)"
        summary = first(connection, f"SELECT count(*) requests,count(distinct user_id) accounts, "
            "coalesce(sum(CASE WHEN state='settled' THEN coalesce(input_tokens,0)+coalesce(output_tokens,0) ELSE 0 END),0) settled_tokens "
            f"FROM model_generations WHERE {predicate}", parameters)
        summary["states"] = rows(connection, f"SELECT state,count(*) requests FROM model_generations "
            f"WHERE {predicate} GROUP BY state ORDER BY state", parameters)
        summary["daily"] = rows(connection,
            "SELECT date(created_at,'+8 hours') day,count(*) requests,count(distinct user_id) accounts,"
            "coalesce(sum(CASE WHEN state='settled' THEN coalesce(input_tokens,0)+coalesce(output_tokens,0) ELSE 0 END),0) settled_tokens "
            f"FROM model_generations WHERE {predicate} GROUP BY day ORDER BY day", parameters)
        summary["last_request_bj"] = latest_bj(first(connection,
            "SELECT max(created_at) latest FROM model_generations WHERE julianday(created_at)<julianday(?)",
            (until.isoformat(),))["latest"])
        classified = rows(connection, f"SELECT user_id,count(*) requests FROM model_generations WHERE {predicate} GROUP BY user_id", parameters)
        summary['audience_usage'] = [{'audience': kind, 'accounts': sum(audience(labels.get(row['user_id'])) == kind for row in classified),
                                     'requests': sum(row['requests'] for row in classified if audience(labels.get(row['user_id'])) == kind)} for kind in AUDIENCES]
        if connection.execute("PRAGMA table_info(agent_events)").fetchall():
            metadata_rows = rows(connection, "SELECT value FROM agent_event_metadata WHERE key='started_at'") if connection.execute("PRAGMA table_info(agent_event_metadata)").fetchall() else []
            events = rows(connection, "SELECT * FROM agent_events WHERE julianday(occurred_at)>=julianday(?) AND julianday(occurred_at)<julianday(?)", parameters)
            lifecycle = [{'identity': row['user_id'], 'occurred_at': row['occurred_at'], 'properties': {key: row[key] for key in ('attempt_id','state','duration','reason')}} for row in events]
            summary['downloads'] = download_report(lifecycle, metadata_rows[0]['value'] if metadata_rows else None, start, until)
            summary['download_audiences'] = {kind: download_report([row for row in lifecycle if audience(labels.get(row['identity'])) == kind], metadata_rows[0]['value'] if metadata_rows else None, start, until) for kind in AUDIENCES}
        else:
            summary['downloads'] = {'status': 'not_instrumented', 'counts': None}
        return summary


def collect(paths=None, days=7, until=None):
    if not 1 <= days <= 90:
        raise ValueError("days must be between 1 and 90")
    paths = dict(DEFAULT_PATHS if paths is None else paths)
    if until is not None and until.tzinfo is None:
        raise ValueError("Cutoff must include a timezone")
    until = (until or datetime.now(BJ)).astimezone(BJ)
    start = until.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)
    report = {
        "schema_version": 1, "product": "geod", "timezone": "Asia/Shanghai",
        "generated_at": datetime.now(BJ).isoformat(timespec="seconds"),
        "window": {"start": start.isoformat(), "until_exclusive": until.isoformat(), "calendar_days": days},
        "identity_scope": "GeoD Studio and GeoD Agent accounts; excludes WeChat Toolbox accounts",
        "notes": [
            "账号数来自 GeoD 自己的账号服务；不读取微信工具箱账户、会话、支付或导出表。",
            "官网仅统计 product=geod-web；桌面匿名安装 ID、官网访客 ID 和账号数分别展示，不相加、不自动关联。",
            "登录会话包含注册后自动登录；退出和清理可能删除会话，保留会话不是完整历史登录次数。",
            "Agent 请求与 token 是模型账本口径；内部、外部、未分类由 GeoD 服务端账号标记区分，未分类不能当作真实外部用户。",
            "注册成功、注册自动建会话、主动登录、Agent 授权和令牌刷新分别计数；认证历史仅覆盖开始记录后的保留区间。",
            "下载结果只覆盖同意统计的客户端观测；完整、部分、失败、取消分别显示，完成率按本期观测开始的同一批尝试计算。",
            "GeoD Studio / Agent 复用 GeoD 账号；这不是旧桌面端的强制登录体系。",
            "今天只统计到截止时间；各来源读取时间略有差异，不是跨库事务快照。",
        ],
        "gaps": ["CLI/MCP 缺少独立活跃埋点"],
        "sources": {},
    }
    # Read labels only from the canonical GeoD store. They never leave this process.
    try:
        labels = {row['id']: audience(row.get('analyticsAudience')) for row in json.loads(Path(paths['accounts']).read_text(encoding='utf-8'))['users'] if timestamp(row['createdAt']) < until}
    except (OSError, ValueError, KeyError, TypeError):
        labels = {}
    collectors = {
        "accounts": lambda: identity_report(paths["accounts"], start, until),
        "desktop": lambda: event_report(paths["desktop"], start, until),
        "website": lambda: event_report(paths["website"], start, until, website=True),
        "agent": lambda: agent_report(paths["agent"], start, until, labels),
    }
    for name, operation in collectors.items():
        try:
            metrics = operation()
            report["sources"][name] = {"status": "ok", "source": paths[name], "metrics": metrics}
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
            # Missing/broken sources are unavailable, never zero activity. Do
            # not print exception messages, which can include sensitive input.
            report["sources"][name] = {"status": "unavailable", "source": paths.get(name),
                "error_type": type(error).__name__, "metrics": None}
    for name, key, label in [('accounts','auth_audit','注册/登录结果历史'), ('desktop','downloads','旧桌面下载结果'), ('agent','downloads','Agent 下载结果')]:
        source = report['sources'][name]
        if source['status'] != 'ok' or source['metrics'][key]['status'] != 'recording':
            report['gaps'].append(label + '尚未开始采集；不计为零')
    if report['sources']['accounts']['status'] == 'ok' and report['sources']['accounts']['metrics']['audience_accounts']['unknown']:
        report['gaps'].append('仍有未分类账号，内部测试与真实用户需要由管理员标记')
    return report


def markdown_report(report):
    sections = report["sources"]
    def metric(name, key):
        return sections[name]["metrics"][key] if sections[name]["status"] == "ok" else "不可用"
    extra = ['', '## 注册与登录结果', '']
    accounts = sections['accounts']['metrics'] if sections['accounts']['status'] == 'ok' else {}
    audit = accounts.get('auth_audit')
    if audit and audit['status'] == 'recording':
        extra += [f"开始记录：{audit['started_at_bj']}；当前保留起点：{audit['retained_from_bj']}", '', '| 操作 | 结果 | 分类 | 次数 |', '|---|---|---|---:|']
        extra += [f"| {row['action']} | {row['outcome']} | {row['audience']} | {row['events']} |" for row in audit['counts']]
    else:
        extra += ['尚未开始采集；保留会话不能替代主动登录次数。']
    extra += ['', '## 账号分类', '', '| 分类 | 账号数 |', '|---|---:|']
    extra += [f'| {kind} | {count} |' for kind,count in accounts.get('audience_accounts',{}).items()]
    agent = sections['agent']['metrics'] if sections['agent']['status'] == 'ok' else {}
    extra += ['', '| 模型使用分类 | 账号数 | 请求数 |', '|---|---:|---:|']
    extra += [f"| {row['audience']} | {row['accounts']} | {row['requests']} |" for row in agent.get('audience_usage',[])]
    for name, label in [('desktop','旧桌面下载结果'), ('agent','Agent 下载结果')]:
        metrics = sections[name]['metrics'] if sections[name]['status'] == 'ok' else {}
        downloads = metrics.get('downloads')
        extra += ['', '## ' + label, '']
        if downloads and downloads['status'] == 'recording':
            extra += [f"服务接入时间：{downloads['started_at_bj']}；本期开始观测：{downloads['observed_starts']}", '', '| 终态 | 尝试数 |', '|---|---:|']
            extra += [f'| {state} | {count} |' for state,count in downloads['counts'].items()]
            rate = downloads['complete_rate']
            extra += ['', '同批完整完成率：' + (f'{rate:.1%}' if rate is not None else '无可计算样本')]
        else:
            extra += ['尚未开始采集或来源不可用；不计为零。']
    return "\n".join([
        "# GeoD 独立运营报表", "", f"北京时间：{report['window']['start']} 至 {report['window']['until_exclusive']}", "",
        "| 指标 | 数量 |", "|---|---:|",
        f"| GeoD 累计账号 | {metric('accounts','total_accounts')} |",
        f"| 本期新账号 | {metric('accounts','new_accounts')} |",
        f"| 本期创建会话的账号 | {metric('accounts','accounts_with_new_session')} |",
        f"| 桌面匿名安装 ID | {metric('desktop','anonymous_ids')} |",
        f"| 官网匿名访客 ID | {metric('website','anonymous_ids')} |",
        f"| Agent 模型使用账号 | {metric('agent','accounts')} |",
        f"| Agent 模型请求 | {metric('agent','requests')} |", *extra, "",
        *[f"- {note}" for note in report["notes"]], "",
        "缺口：" + "；".join(report["gaps"]), "",
    ])


def html_report(report):
    escape = lambda value: html.escape(str(value if value is not None else "暂无记录"))
    sources = report["sources"]
    def time_label(value):
        return timestamp(value).astimezone(BJ).strftime('%Y-%m-%d %H:%M:%S') if value else '暂无记录'
    event_labels = {
        'download_task_state':'下载结果与开始观测',
        'app_started':'应用启动', 'sidebar_tab_changed':'侧栏切换', 'mode_changed':'下载模式切换',
        'selection_changed':'区域选择', 'download_task_created':'下载任务创建', 'task_action':'任务操作',
        'graticule_changed':'经纬网设置', 'onboarding_event':'使用引导', 'measurement_used':'测量操作',
        'region_imported':'区域导入', 'assistant_panel_action':'AI 助手面板操作',
        'assistant_setting_changed':'AI 助手设置', 'assistant_request':'AI 助手请求',
        'assistant_navigation':'AI 助手导航', 'bookmark_action':'书签操作',
        'page_view':'页面浏览', 'download_clicked':'安装包下载点击',
        'browser_download_started':'网页下载开始', 'browser_plan_created':'网页计划创建',
        'browser_download_failed':'网页下载失败', 'browser_download_completed':'网页下载完成',
        'browser_save_clicked':'网页保存点击', 'install_link_clicked':'安装链接点击',
    }
    def metric(name, key):
        source = sources[name]
        return source["metrics"][key] if source["status"] == "ok" else "不可用"
    def table(headers, records):
        return '<div class="table-wrap"><table><thead><tr>' + ''.join(f'<th>{escape(h)}</th>' for h in headers) + \
            '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{escape(v)}</td>' for v in row) + '</tr>' for row in records) + '</tbody></table></div>'
    def downloads_panel(downloads):
        if not downloads or downloads['status'] != 'recording':
            return '<h3>下载结果</h3><p class="warning">尚未开始采集；结果不可用，不是零次。</p>'
        labels = {'completed':'完整完成','partial':'部分完成','completed_with_gaps':'部分完成','failed':'失败','cancelled':'取消','pending':'尚未观测到结果'}
        rate = downloads['complete_rate']
        body = '<h3>下载结果</h3><p class="freshness">服务接入时间：' + escape(time_label(downloads['started_at_bj'])) + '</p>'
        body += table(['本期终态','观测尝试'], [[labels[key], downloads['counts'].get(key,0)] for key in ('completed','partial','completed_with_gaps','failed','cancelled') if key != ('partial' if 'completed_with_gaps' in downloads['counts'] else 'completed_with_gaps')])
        body += '<p>本期观测开始：<b>' + escape(downloads['observed_starts']) + '</b>；同批完整完成率：<b>' + escape(f'{rate:.1%}' if rate is not None else '无可计算样本') + '</b></p>'
        body += table(['同批尝试结果','数量'], [[labels[key], count] for key,count in downloads['start_cohort_results'].items()])
        if downloads['durations']:
            duration_labels = {'unknown':'无法确定','under_10s':'不足 10 秒','10-60s':'10 秒至 1 分钟','1-5m':'1 至 5 分钟','5-30m':'5 至 30 分钟','30m+':'30 分钟以上'}
            body += table(['终态耗时区间','尝试'], [[duration_labels.get(key,key), count] for key,count in downloads['durations'].items()])
        if downloads['failure_reasons']:
            reason_labels = {'network':'网络','auth':'认证','disk':'磁盘','permission':'权限','missing_tiles':'缺失瓦片','unknown':'未分类'}
            body += table(['失败或部分完成类别','尝试'], [[reason_labels.get(key,key),count] for key,count in downloads['failure_reasons'].items()])
        return body
    cards = ''.join(f'<article><span>{escape(label)}</span><strong>{escape(value)}</strong><small>{escape(detail)}</small></article>' for label, value, detail in [
        ('GeoD 累计账号', metric('accounts', 'total_accounts'), 'GeoD Studio / Agent 账号服务'),
        ('本期新账号', metric('accounts', 'new_accounts'), '服务端实际创建'),
        ('本期有新会话的账号', metric('accounts', 'accounts_with_new_session'), '含注册后自动登录'),
        ('桌面匿名安装 ID', metric('desktop', 'anonymous_ids'), '仅同意上报的安装'),
        ('官网匿名访客 ID', metric('website', 'anonymous_ids'), '仅 GeoD 官网事件'),
        ('Agent 模型使用账号', metric('agent', 'accounts'), '包含可能的内部测试'),
    ])
    daily_maps = {name: {row['day']: row for row in (source['metrics']['daily'] if source['status']=='ok' else [])}
                  for name, source in sources.items()}
    daily_records = []
    start = timestamp(report['window']['start'])
    for offset in range(report['window']['calendar_days']):
        day = (start + timedelta(days=offset)).date().isoformat()
        record = [day]
        for name, key in [('accounts','new_accounts'), ('accounts','retained_sessions_created'),
                          ('desktop','anonymous_ids'), ('website','anonymous_ids'), ('agent','requests')]:
            record.append(daily_maps[name].get(day, {}).get(key, 0) if sources[name]['status']=='ok' else '不可用')
        daily_records.append(record)
    panels = []
    for name, label, freshness_keys in [
        ('accounts','GeoD 账号', ['last_registered_bj','last_session_created_bj']),
        ('desktop','旧桌面匿名埋点', ['last_event_bj','last_received_bj']),
        ('website','GeoD 官网', ['last_event_bj','last_received_bj']),
        ('agent','Agent 模型账本', ['last_request_bj']),
    ]:
        source = sources[name]
        metrics = source['metrics']
        if source['status'] != 'ok':
            body = '<p class="warning">来源不可用；不能解释为零使用。</p>'
        else:
            details = [(['最近注册','最近会话创建'] if name=='accounts' else
                        ['最近请求'] if name=='agent' else ['最近发生','最近入库'])[index] + '：' + escape(time_label(metrics[key]))
                       for index,key in enumerate(freshness_keys)]
            body = '<p class="freshness">' + '<br>'.join(details) + '</p>'
            if name in ('desktop','website'):
                body += table(['事件','次数','匿名 ID'], [[event_labels.get(r['event_name'],r['event_name']),r['events'],r['anonymous_ids']] for r in metrics['event_counts']])
                if name=='website' and metrics['download_failure_reasons']:
                    body += '<h3>网页下载失败原因</h3>' + table(['原因','次数'], [['需要登录' if r['reason']=='auth_required' else r['reason'],r['events']] for r in metrics['download_failure_reasons']])
                if name == 'desktop': body += downloads_panel(metrics.get('downloads'))
            elif name=='agent':
                body += '<p>已结算 token：<b>' + escape(metrics['settled_tokens']) + '</b></p>'
                state_labels = {'settled':'已结算','failed':'失败','pending_reconcile':'待对账','streaming':'处理中','reserved':'已预留'}
                body += table(['请求状态','次数'], [[state_labels.get(r['state'],r['state']),r['requests']] for r in metrics['states']])
                audience_labels = {'internal':'内部测试','external':'外部用户','unknown':'未分类'}
                body += table(['服务端分类','使用账号','模型请求'], [[audience_labels[r['audience']],r['accounts'],r['requests']] for r in metrics.get('audience_usage',[])])
                body += downloads_panel(metrics.get('downloads'))
                if metrics.get('download_audiences'):
                    body += table(['下载分类','开始观测','完整完成'], [[audience_labels[kind],value.get('observed_starts','不可用'),(value.get('counts') or {}).get('completed',0) if value['status']=='recording' else '不可用'] for kind,value in metrics['download_audiences'].items()])
            else:
                body += '<p>本期保留的新建会话：<b>' + escape(metrics['retained_sessions_in_window']) + '</b>；已验证邮箱账号：<b>' + escape(metrics['verified_accounts']) + '</b></p>'
                body += table(['账号分类','账号数'], [[{'internal':'内部测试','external':'外部用户','unknown':'未分类'}[key], value] for key,value in metrics.get('audience_accounts',{}).items()])
                audit = metrics.get('auth_audit')
                if not audit or audit['status'] != 'recording':
                    body += '<h3>注册与登录结果</h3><p class="warning">历史尚未开始采集；保留会话数不能替代主动登录次数。</p>'
                else:
                    body += '<h3>注册与登录结果</h3><p class="freshness">开始记录：' + escape(time_label(audit['started_at_bj'])) + '<br>当前保留起点：' + escape(time_label(audit['retained_from_bj'])) + '</p>'
                    action_labels = {'register':'注册','login':'主动登录','session_created':'注册自动建会话','oauth_exchange':'Agent 授权','token_refresh':'令牌刷新','password_reset':'密码重置'}
                    body += table(['操作','结果','分类','次数'], [[action_labels.get(r['action'],r['action']),'成功' if r['outcome']=='success' else '失败',{'internal':'内部测试','external':'外部用户','unknown':'未分类'}[r['audience']],r['events']] for r in audit['counts']])
                    if audit.get('failure_reasons'):
                        reason_labels = {'INVALID_CREDENTIALS':'账号或密码不匹配','LOGIN_RATE_LIMIT':'登录过于频繁','INVALID_EMAIL':'邮箱格式错误','INVALID_PASSWORD':'密码不符合要求','INVITE_INVALID':'邀请无效','INVALID_GRANT':'授权或令牌无效','VERIFICATION_INVALID':'验证码无效','VERIFICATION_UNAVAILABLE':'验证服务不可用','ACCOUNT_ALREADY_REGISTERED':'账号已注册','ACCOUNT_NOT_FOUND':'账号不存在','AUTH_NOT_CONFIGURED':'认证服务未配置','AUTH_REQUIRED':'需要重新登录','INVALID_CHANNEL':'验证渠道无效','INVALID_PURPOSE':'验证类型无效','IDENTITY_ALREADY_BOUND':'联系方式已绑定','OTHER':'其他'}
                        body += table(['失败操作','类别','次数'], [[action_labels.get(r['action'],r['action']),reason_labels.get(r['reason'],'其他'),r['events']] for r in audit['failure_reasons']])
        panels.append(f'<section><h2>{label}</h2>{body}<p class="source">{escape(source["source"])}</p></section>')
    notes = ''.join('<li>' + escape(note) + '</li>' for note in report['notes'])
    gaps = ''.join('<li>' + escape(gap) + '</li>' for gap in report['gaps'])
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GeoD 独立运营报表</title><style>' + CSS + '</style><body><main>' + \
        '<header><div class="brand">GeoD · 运营</div><h1>GeoD 独立运营报表</h1><p>账号、官网、桌面与 Agent · 仅 GeoD 数据</p>' + \
        '<p class="freshness">北京时间 ' + escape(time_label(report['window']['start'])) + ' 至 ' + escape(time_label(report['window']['until_exclusive'])) + \
        '<br>生成时间 ' + escape(time_label(report['generated_at'])) + ' · 手动刷新快照</p></header><div class="cards">' + cards + '</div>' + \
        '<section><h2>每日活动</h2>' + table(['日期','新账号','新建会话','桌面安装 ID','官网访客 ID','模型请求'], daily_records) + '</section>' + \
        '<div class="panels">' + ''.join(panels) + '</div><section><h2>统计口径与隔离边界</h2><ul>' + notes + '</ul></section>' + \
        '<section><h2>当前尚缺的统计</h2><ul>' + gaps + '</ul></section></main></body></html>'


CSS = """
:root{color-scheme:light;--bg:#f7f9fc;--surface:#fff;--text:#142033;--muted:#536276;--border:#dce3ed;--blue:#1d4ed8}
*{box-sizing:border-box}html,body{scrollbar-width:none}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,'Microsoft YaHei',sans-serif}
main{max-width:1180px;margin:auto;padding:40px 28px 64px}header{margin-bottom:26px}.brand{color:var(--blue);font-weight:700;letter-spacing:.04em}h1{font-size:28px;line-height:1.3;margin:10px 0}h2{font-size:18px;margin:0 0 14px}p{margin:8px 0}.freshness,.source,small{color:var(--muted);font-size:13px}.source{overflow-wrap:anywhere;margin-top:16px}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:20px}article,section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px}article span,article small{display:block}article strong{display:block;font-size:32px;line-height:1.5;font-variant-numeric:tabular-nums}.panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:20px 0}main>section{margin-top:20px}.table-wrap{overflow-x:auto;scrollbar-width:thin;scrollbar-color:#9cabc0 transparent}.table-wrap::-webkit-scrollbar{height:6px}.table-wrap::-webkit-scrollbar-thumb{background:#9cabc0;border-radius:8px}.table-wrap::-webkit-scrollbar-track{background:transparent}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}th{background:#f1f5fa;color:var(--muted);font-weight:600}li{margin:8px 0}ul{padding-left:22px;margin-bottom:0}.warning{color:#9a3412}h3{font-size:14px;margin:20px 0 8px}
@media(max-width:720px){main{padding:22px 16px 40px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.panels{grid-template-columns:1fr}article,section{padding:16px}h1{font-size:24px}article strong{font-size:28px}}
@media(max-width:380px){.cards{grid-template-columns:1fr}}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    collect_parser = sub.add_parser("collect")
    collect_parser.add_argument("--days", type=int, default=7)
    collect_parser.add_argument("--until", type=timestamp)
    for name, path in DEFAULT_PATHS.items():
        collect_parser.add_argument("--" + name, default=path)
    render_parser = sub.add_parser("render")
    render_parser.add_argument("snapshot", type=Path)
    render_parser.add_argument("output_directory", type=Path)
    options = parser.parse_args()
    if options.command == "collect":
        print(json.dumps(collect({name:getattr(options,name) for name in DEFAULT_PATHS}, options.days, options.until), ensure_ascii=False, indent=2))
    else:
        report = json.loads(options.snapshot.read_text(encoding="utf-8-sig"))
        if report.get("product") != "geod" or report.get("schema_version") != 1:
            raise ValueError("Not a GeoD report snapshot")
        options.output_directory.mkdir(parents=True, exist_ok=True)
        (options.output_directory / "report.html").write_text(html_report(report), encoding="utf-8")
        (options.output_directory / "report.md").write_text(markdown_report(report), encoding="utf-8")
        print(str((options.output_directory / "report.html").resolve()))


if __name__ == "__main__":
    main()
