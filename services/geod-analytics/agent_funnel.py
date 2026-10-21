"""Agent-only funnel: separate anonymous traffic from account cohorts."""
import json,sqlite3,argparse
from pathlib import Path
from datetime import datetime,timedelta,timezone
from agent_activity_report import collect,stamp

def website(path,start,until):
    try:
        c=sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True)
        c.execute('PRAGMA query_only=ON');c.execute('BEGIN')
        c.set_authorizer(lambda a,t,col,d,s:sqlite3.SQLITE_DENY if a==sqlite3.SQLITE_READ and t!='product_events' else sqlite3.SQLITE_OK)
        rows=[(name,visitor,stamp(at),json.loads(props)) for name,visitor,at,props in c.execute('SELECT event_name,visitor_id,occurred_at,properties_json FROM product_events WHERE product=? AND julianday(occurred_at)<julianday(?)',('geod-web',until.isoformat()))]
        c.close()
        internal={visitor for _,visitor,_,p in rows if p.get('source')=='geod-internal'}
        def agent(p):return p.get('path','').rstrip('/') in ['/agent','/en/agent']
        eligible=[r for r in rows if start<=r[2] and r[1] not in internal]
        views=[r for r in eligible if r[0]=='page_view' and agent(r[3])]
        clicks=[r for r in eligible if r[0]=='download_clicked' and (r[3].get('campaign')=='geod-agent-download' or (agent(r[3]) and str(r[3].get('version','')).lstrip('v').startswith('0.')))]
        marker=min((r[2] for r in rows if r[3].get('campaign')=='geod-agent-download'),default=None)
        return {'status':'observed','page_views':len(views),'anonymous_visitor_ids':len({r[1] for r in views}),'observed_download_clicks':len(clicks) if marker else None,'download_click_first_retained_observation':marker.isoformat() if marker else None,'download_click_coverage':'partial_or_unknown_start','installer_downloads_completed':None,'installations_completed':None,'marked_internal_visitor_ids_excluded':len(internal),'unmarked_owner_test_visits_may_remain':True,'visitor_to_account_join_available':False}
    except (OSError,sqlite3.Error,ValueError,TypeError):
        return {'status':'unavailable','page_views':None,'anonymous_visitor_ids':None,'observed_download_clicks':None,'installer_downloads_completed':None,'installations_completed':None}

def funnel(hours=168,until=None,accounts='/srv/laogao/data/geod-studio/accounts/store.json',ledger='/srv/laogao/data/geod-agent/agent-model.sqlite',web='/srv/laogao/data/platform-api/platform-api.sqlite'):
    until=until or datetime.now(timezone(timedelta(hours=8)));start=until-timedelta(hours=hours)
    base=collect(hours=hours,until=until,accounts=accounts,ledger=ledger)
    store=json.loads(Path(accounts).read_text());excluded={u['id'] for u in store['users'] if u.get('email','').lower() in {'1804287165@qq.com','pengbingao@gmail.com'} or u.get('analyticsAudience')=='internal' or u.get('isTestAccount') is True}
    cohort={u['id'] for u in store['users'] if u['id'] not in excluded and start<=stamp(u['createdAt'])<until}
    c=sqlite3.connect(Path(ledger).resolve().as_uri()+'?mode=ro',uri=True);c.execute('PRAGMA query_only=ON')
    tables={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # Earliest retained completion per account, never SUM of event counts.
    def first_count(table,predicate):
        if table not in tables:return None
        if table=='agent_activity_events' and not c.execute(f'SELECT 1 FROM {table} WHERE {predicate} AND julianday(occurred_at)<julianday(?) LIMIT 1',(until.isoformat(),)).fetchone():return None
        return sum(uid in cohort and start<=stamp(at)<until for uid,at in c.execute(f'SELECT user_id,min(occurred_at) FROM {table} WHERE {predicate} AND julianday(occurred_at)<julianday(?) GROUP BY user_id',(until.isoformat(),)))
    success=first_count('agent_events',"state='completed'")
    runs=first_count('agent_activity_events',"kind='app_first_seen'")
    personal=first_count('agent_activity_events',"kind='personal_model' AND state='completed'")
    c.close()
    users=base['new_user_activity']
    return {'product':'geod-agent','window':base['window'],'website':website(web,start,until),'account_cohort':{'shared_geod_registrations':len(cohort),'retained_agent_authorization_accounts':sum(u['agent_authorized'] for u in users),'hosted_or_sponsored_settled_accounts':sum(any(r['state']=='settled' for r in u['server_model_requests']) for u in users),'observed_personal_completion_accounts':personal,'observed_first_client_accounts':runs,'observed_first_download_completion_accounts':success,'excluded_accounts':len(excluded)},'coverage':{'registration_is_shared_with_studio':True,'authorization_history_may_be_pruned':True,'first_client_event_means_first_observed_after_opt_in_not_install':True,'personal_and_download_collection_opt_in':True,'historical_unobserved_usage_is_unknown':True,'download_completion_is_not_general_workflow_acceptance':True,'full_funnel_conversion_rate':None},'agent_activity':base['usage_excluding_owner_and_internal']}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--hours',type=int,default=168);p.add_argument('--until');p.add_argument('--accounts',default='/srv/laogao/data/geod-studio/accounts/store.json');p.add_argument('--ledger',default='/srv/laogao/data/geod-agent/agent-model.sqlite');p.add_argument('--web',default='/srv/laogao/data/platform-api/platform-api.sqlite');a=p.parse_args()
    print(json.dumps(funnel(a.hours,stamp(a.until) if a.until else None,a.accounts,a.ledger,a.web),ensure_ascii=False,indent=2))
