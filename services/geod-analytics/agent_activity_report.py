"""Read-only GeoD Agent report. Never reads legacy desktop or shared accounts."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import argparse
import json
import sqlite3

BJ=timezone(timedelta(hours=8))
def stamp(value):
    return datetime.fromisoformat(value.replace('Z','+00:00'))
def masked(email):
    local,_,domain=email.partition('@')
    return local[:2]+'***'+local[-2:]+'@'+domain
def collect(hours=48,until=None,accounts='/srv/laogao/data/geod-studio/accounts/store.json',ledger='/srv/laogao/data/geod-agent/agent-model.sqlite'):
    if not 1<=hours<=2160:raise ValueError('Invalid hours')
    until=until or datetime.now(BJ);start=until-timedelta(hours=hours)
    store=json.loads(Path(accounts).read_text(encoding='utf8'))
    users=[u for u in store['users'] if u.get('email','').lower() not in {'1804287165@qq.com','pengbingao@gmail.com'} and u.get('analyticsAudience')!='internal' and u.get('isTestAccount') is not True and stamp(u['createdAt'])<until]
    db=sqlite3.connect(Path(ledger).resolve().as_uri()+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
    tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'agent_telemetry_internal_users' in tables:
        internal={r[0]for r in db.execute('SELECT user_id FROM agent_telemetry_internal_users')}
        users=[u for u in users if u['id']not in internal]
    cohort=[];summary={}
    try:
        ids=[u['id'] for u in users];marks=','.join('?' for _ in ids) or 'NULL'
        def grouped(table,columns,time_column):
            if table not in tables:return None
            return [dict(r) for r in db.execute(f'SELECT {columns} FROM {table} WHERE user_id IN ({marks}) AND julianday({time_column})>=julianday(?) AND julianday({time_column})<julianday(?) GROUP BY 1,2',ids+[start.isoformat(),until.isoformat()])]
        summary['server_model_requests']=grouped('model_generations','funding_scope,state,count(*) requests,count(distinct user_id) accounts','created_at')
        summary['reported_downloads']=grouped('agent_events','state,download_kind,count(*) attempts,count(distinct user_id) accounts','occurred_at')
        detail_columns={r[1] for r in db.execute('PRAGMA table_info(agent_events)')} if 'agent_events' in tables else set()
        detail_rows=[dict(r) for r in db.execute(f'SELECT state,client_version,diagnostic_status,diagnostic_json FROM agent_events WHERE user_id IN ({marks}) AND julianday(occurred_at)>=julianday(?) AND julianday(occurred_at)<julianday(?) AND state!=\'started\'',ids+[start.isoformat(),until.isoformat()])] if {'diagnostic_json','diagnostic_status','client_version'}<=detail_columns else None
        summary['download_details']={'status':'unavailable' if detail_rows is None else 'observed' if detail_rows else 'not_observed','terminal_events':None if detail_rows is None else len(detail_rows),'details':detail_rows}
        summary['reported_personal_activity']=grouped('agent_activity_events','kind,state,count(*) events,count(distinct user_id) accounts,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(usage_known=0) unknown_usage_events','occurred_at')
        diagnostic_available='agent_activity_events' in tables and 'reason' in {r[1] for r in db.execute('PRAGMA table_info(agent_activity_events)')}
        summary['download_reporting_diagnostics']=[dict(r) for r in db.execute(f"SELECT reason,count(distinct user_id) accounts,count(*) events,max(occurred_at) last_observed_at FROM agent_activity_events WHERE user_id IN ({marks}) AND kind='download_status' AND julianday(occurred_at)>=julianday(?) AND julianday(occurred_at)<julianday(?) GROUP BY reason",ids+[start.isoformat(),until.isoformat()])] if diagnostic_available else None
        summary['download_reporting_diagnostics_status']='observed' if summary['download_reporting_diagnostics'] else 'not_observed' if diagnostic_available else 'unavailable'
        for u in users:
            if stamp(u['createdAt'])<start:continue
            uid=u['id'];grants=[g for g in store.get('geodOAuthGrants',[]) if g.get('userId')==uid and g.get('clientId')=='geod-agent-desktop']
            item={'account':masked(u.get('email','')),'registered_at':stamp(u['createdAt']).astimezone(BJ).isoformat(),'agent_authorized':bool(grants),'retained_agent_grants':len(grants)}
            item['server_model_requests']=[dict(r) for r in db.execute('SELECT funding_scope,state,count(*) requests FROM model_generations WHERE user_id=? AND julianday(created_at)<julianday(?) GROUP BY funding_scope,state',[uid,until.isoformat()])]
            item['reported_downloads']=[dict(r) for r in db.execute('SELECT state,download_kind,count(*) attempts FROM agent_events WHERE user_id=? AND julianday(occurred_at)<julianday(?) GROUP BY state,download_kind',[uid,until.isoformat()])]
            item['personal_activity_collection_available']='agent_activity_events' in tables
            latest=db.execute("SELECT state,reason,occurred_at FROM agent_activity_events WHERE user_id=? AND kind='download_status' AND julianday(occurred_at)<julianday(?) ORDER BY julianday(occurred_at) DESC,rowid DESC LIMIT 1",[uid,until.isoformat()]).fetchone() if diagnostic_available else None
            item['download_reporting_status']=dict(latest) if latest else None
            item['reported_activity']=[dict(r) for r in db.execute('SELECT kind,state,count(*) events,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(usage_known=0) unknown_usage_events FROM agent_activity_events WHERE user_id=? AND julianday(occurred_at)<julianday(?) GROUP BY kind,state',[uid,until.isoformat()])] if 'agent_activity_events' in tables else None
            cohort.append(item)
    finally:db.close()
    return {'product':'geod-agent','window':{'start':start.isoformat(),'until_exclusive':until.isoformat()},'nonowner_accounts':len(users),'new_accounts':len(cohort),'new_user_activity':cohort,'usage_excluding_owner_and_internal':summary,'excluded_internal_accounts':sum(u.get('analyticsAudience')=='internal' for u in store['users']),'limitations':['Account registration is shared with GeoD Studio; desktop authorization proves connection, not a completed task.','Personal usage is client-reported opt-in telemetry, separate from the verified hosted/sponsored ledger and Credits.','Old clients and disabled telemetry are unobservable, not inactive. No backfill of private local history.','Download outcomes only cover opted-in clients. Unknown test accounts remain unclassified.']}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--hours',type=int,default=48);parser.add_argument('--until');args=parser.parse_args()
    print(json.dumps(collect(hours=args.hours,until=stamp(args.until) if args.until else None),ensure_ascii=False,indent=2))
