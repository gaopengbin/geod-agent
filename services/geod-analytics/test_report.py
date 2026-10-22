import importlib.util
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime

spec = importlib.util.spec_from_file_location("geod_report", Path(__file__).with_name("report.py"))
report_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report_module)


@contextmanager
def fixture_database(path):
    connection = sqlite3.connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


class GeoDReportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.paths = {name: str(self.root / (name + (".json" if name == "accounts" else ".sqlite")))
                      for name in report_module.DEFAULT_PATHS}
        self.until = datetime.fromisoformat("2026-10-02T10:00:00+08:00")
        self.identity = {
            "users": [
                {"id": "geod-user", "createdAt": "2026-09-26T00:00:00+08:00", "email": "private@example.test", "passwordHash": "sensitive-password"},
                {"id": "future-user", "createdAt": "2026-10-02T11:00:00+08:00"},
            ],
            "sessions": [
                {"userId": "geod-user", "createdAt": "2026-10-01T01:00:00Z", "expiresAt": "2026-11-01T00:00:00Z", "tokenHash": "sensitive-session"},
                {"userId": "wechat-user", "createdAt": "2026-10-01T01:00:00Z", "expiresAt": "2026-11-01T00:00:00Z"},
            ],
            "geodOAuthGrants": [
                {"userId": "geod-user", "clientId": "geod-agent-desktop", "accessHash": "sensitive-access"},
                {"userId": "geod-user", "clientId": "another-product"},
            ],
        }
        self.write_identity()
        with fixture_database(self.paths["desktop"]) as db:
            db.execute("CREATE TABLE events(event_name,occurred_at,install_id,session_id,received_at,properties_json)")
            db.execute("INSERT INTO events VALUES(?,?,?,?,?,?)", ('download_task_created','2026-09-25T16:00:00Z','anonymous-device','s1','2026-09-25T16:00:01Z','{"workflow":"raster"}'))
            db.execute("INSERT INTO events VALUES(?,?,?,?,?,?)", ('app_started','2026-10-02T02:01:00Z','future-device','s2','2026-10-02T02:01:00Z','{}'))
        with fixture_database(self.paths["website"]) as db:
            db.execute("CREATE TABLE product_events(product,event_name,occurred_at,visitor_id,session_id,received_at,properties_json)")
            db.execute("CREATE TABLE accounts(id,email)")
            db.execute("CREATE TABLE account_sessions(user_id)")
            db.execute("INSERT INTO accounts VALUES('wechat-user','wechat@example.test')")
            for product in ['geod-web','wechat-dialog-generator','geostyle-web']:
                db.execute("INSERT INTO product_events VALUES(?,?,?,?,?,?,?)", (product,'page_view','2026-10-01T02:00:00Z',product+'-visitor','s1','2026-10-01T02:00:01Z','{}'))
        with fixture_database(self.paths["agent"]) as db:
            db.execute("CREATE TABLE model_generations(user_id,created_at,state,input_tokens,output_tokens,response_ciphertext)")
            db.executemany("INSERT INTO model_generations VALUES(?,?,?,?,?,?)", [
                ('geod-user','2026-10-01T02:00:00Z','settled',10,5,'private-model-response'),
                ('geod-user','2026-10-01T03:00:00Z','failed',100,20,'private-model-response'),
            ])

    def tearDown(self):
        self.directory.cleanup()

    def write_identity(self):
        Path(self.paths['accounts']).write_text(json.dumps(self.identity), encoding='utf-8')

    def collect(self):
        return report_module.collect(self.paths, 7, self.until)

    def test_token_diagnostics_deduplicate_attempts_preserve_missing_and_export_no_ids(self):
        props = {'attempt_id':'private-attempt','state':'failed','reason':'auth','diagnostic_version':1,
                 'provider':'tianditu','phase':'overlay_download','token_source':'user','configured_tokens':3,
                 'used_tokens':3,'token_switches':2,'recovered_switches':1,'settings_updates':0,
                 'last_rejection_status':429,'tokens_exhausted':True,'error_code':'all_tokens_unavailable','http_status':429,
                 'token':'private-secret','url':'https://private.test'}
        def record(properties):
            return {'identity':'private-install','occurred_at':'2026-10-01T02:00:00Z','app_version':'3.6.17','properties':properties}
        results = report_module.token_diagnostics_report([record(props),record(props),record(dict(props,attempt_id='old',diagnostic_version=None))])
        self.assertEqual(results['diagnosed_terminal_attempts'],1)
        self.assertEqual(results['terminal_without_diagnostics'],1)
        self.assertEqual(results['switched_attempts'],1)
        self.assertEqual(results['recovered_attempts'],1)
        self.assertEqual(results['exhausted_attempts'],1)
        self.assertNotIn('private',json.dumps(results))
        self.assertNotIn('https',json.dumps(results))
        collected=self.collect()
        collected['sources']['desktop']['metrics']['token_diagnostics']=results
        rendered=report_module.html_report(collected)
        self.assertIn('所有配置 Token 被拒绝',rendered)
        self.assertIn('切换后取片成功',rendered)
        self.assertNotIn('private-secret',rendered)

    def test_old_or_malformed_diagnostics_are_not_zero_token_samples(self):
        old={'identity':'x','occurred_at':'2026-10-01T02:00:00Z','properties':{'attempt_id':'x','state':'completed'}}
        result=report_module.token_diagnostics_report([old])
        self.assertEqual(result['status'],'no_observations')
        self.assertEqual(result['terminal_without_diagnostics'],1)
        self.assertEqual(result['details'],[])

    def test_wechat_accounts_and_events_cannot_change_geod_results(self):
        before = self.collect()
        with fixture_database(self.paths['website']) as db:
            db.executemany("INSERT INTO accounts VALUES(?,?)", [(f'wechat-{i}',f'wechat-{i}@example.test') for i in range(100)])
            db.executemany("INSERT INTO product_events VALUES(?,?,?,?,?,?,?)", [
                ('wechat-dialog-generator','account_request','2026-10-02T01:59:59Z',f'w-{i}','ws','2026-10-02T01:59:59Z','{"action":"register"}') for i in range(100)])
        after = self.collect()
        self.assertEqual(before['sources'], after['sources'])
        self.assertEqual(after['sources']['accounts']['metrics']['total_accounts'], 1)
        self.assertEqual(after['sources']['website']['metrics']['events'], 1)
        self.assertEqual(after['sources']['website']['metrics']['last_event_bj'], '2026-10-01T10:00:00+08:00')

    def test_platform_account_tables_are_denied(self):
        with report_module.readonly_database(self.paths['website'], {'product_events'}) as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute('SELECT count(*) FROM accounts').fetchone()
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("INSERT INTO product_events(product) VALUES('geod-web')")

    def test_beijing_window_excludes_future_and_foreign_sessions(self):
        result = self.collect()['sources']
        self.assertEqual(result['accounts']['metrics']['new_accounts'], 1)
        self.assertEqual(result['accounts']['metrics']['accounts_with_new_session'], 1)
        self.assertEqual(result['accounts']['metrics']['retained_sessions_in_window'], 1)
        self.assertEqual(result['accounts']['metrics']['accounts_with_retained_agent_grant'], 1)
        self.assertEqual(result['desktop']['metrics']['events'], 1)
        self.assertEqual(result['desktop']['metrics']['daily'][0]['day'], '2026-09-26')
        self.assertEqual(result['agent']['metrics']['settled_tokens'], 15)

    def test_missing_source_is_unavailable_not_zero_and_never_created(self):
        missing = self.root / 'absent.sqlite'
        paths = dict(self.paths, desktop=str(missing))
        result = report_module.collect(paths, 7, self.until)
        self.assertEqual(result['sources']['desktop']['status'], 'unavailable')
        self.assertIsNone(result['sources']['desktop']['metrics'])
        self.assertFalse(missing.exists())
        self.assertIn('不可用', report_module.html_report(result))

    def test_collection_never_modifies_sources_or_exports_personal_data(self):
        original = {key: Path(path).read_bytes() for key,path in self.paths.items()}
        result = self.collect()
        for key,path in self.paths.items():
            self.assertEqual(original[key], Path(path).read_bytes())
        serialized = json.dumps(result) + report_module.html_report(result) + report_module.markdown_report(result)
        for secret in ['private@example.test','sensitive-password','sensitive-session','sensitive-access','private-model-response','wechat@example.test','anonymous-device']:
            self.assertNotIn(secret, serialized)

    def test_corrupt_identity_does_not_fall_back_to_platform_accounts(self):
        Path(self.paths['accounts']).write_text('{broken', encoding='utf-8')
        result = self.collect()
        self.assertEqual(result['sources']['accounts']['status'], 'unavailable')
        self.assertIsNone(result['sources']['accounts']['metrics'])
        self.assertEqual(result['sources']['website']['status'], 'ok')

    def test_html_escapes_event_data(self):
        with fixture_database(self.paths['desktop']) as db:
            db.execute("UPDATE events SET event_name='<script>bad()</script>'")
        output = report_module.html_report(self.collect())
        self.assertNotIn('<script>bad()</script>', output)
        self.assertIn('&lt;script&gt;bad()', output)

    def test_missing_new_instrumentation_is_unavailable_not_zero(self):
        result = self.collect()
        self.assertEqual(result['sources']['accounts']['metrics']['auth_audit'], {'status': 'not_instrumented', 'counts': None})
        for name in ['desktop', 'agent']:
            self.assertIsNone(result['sources'][name]['metrics']['downloads']['counts'])
        self.assertIn('尚未开始采集', report_module.html_report(result))

    def test_auth_outcomes_are_independent_of_retained_sessions(self):
        self.identity['sessions'] = []
        self.identity['users'][0]['analyticsAudience'] = 'internal'
        self.identity['authAudit'] = {'version': 1, 'startedAt': '2026-10-01T00:00:00Z', 'events': [
            {'occurredAt': '2026-10-01T01:00:00Z', 'action': action, 'outcome': outcome,
             'channel': 'agent' if action == 'token_refresh' else 'web', 'mode': mode, 'audience': 'internal'}
            for action, outcome, mode in [('register','success','explicit'), ('session_created','success','registration_auto'),
                                         ('login','success','explicit'), ('login','failure','explicit'), ('token_refresh','success','refresh')]]}
        self.write_identity()
        result = self.collect()
        accounts = result['sources']['accounts']['metrics']
        self.assertEqual(accounts['retained_sessions_in_window'], 0)
        self.assertEqual(len(accounts['auth_audit']['counts']), 5)
        self.assertEqual(accounts['audience_accounts'], {'internal': 1, 'external': 0, 'unknown': 0})
        agent = result['sources']['agent']['metrics']
        self.assertEqual(agent['audience_usage'][0], {'audience': 'internal', 'accounts': 1, 'requests': 2})
        self.assertEqual(agent['audience_usage'][1]['accounts'], 0)
        self.assertNotIn('geod-user', json.dumps(result))

    def test_download_results_deduplicate_and_use_start_cohort_for_rate(self):
        with fixture_database(self.paths['desktop']) as db:
            db.execute('CREATE TABLE telemetry_metadata(key,value)')
            db.execute("INSERT INTO telemetry_metadata VALUES ('download_lifecycle_started_at','2026-09-25T00:00:00Z')")
            for identity, attempt, state, at in [('d1','a','started','2026-10-01T00:00:00Z'), ('d1','a','completed','2026-10-01T01:00:00Z'),
                ('d1','a','completed','2026-10-01T01:00:00Z'), ('d1','b','started','2026-10-01T00:00:00Z'),
                ('d1','b','failed','2026-10-01T01:00:00Z'), ('d1','c','started','2026-10-01T00:00:00Z'),
                ('d2','a','started','2026-09-25T00:00:00Z'), ('d2','a','completed','2026-10-01T01:00:00Z')]:
                props = json.dumps({'attempt_id': attempt, 'state': state, 'duration':'10-60s', 'reason':'network' if state=='failed' else 'none'})
                db.execute('INSERT INTO events VALUES (?,?,?,?,?,?)', ('download_task_state',at,identity,'s1',at,props))
        results = self.collect()['sources']['desktop']['metrics']['downloads']
        self.assertEqual(results['counts'], {'completed': 2, 'failed': 1})
        self.assertEqual(results['observed_starts'], 3)
        self.assertAlmostEqual(results['complete_rate'], 1/3)
        self.assertEqual(results['start_cohort_results'], {'completed': 1, 'failed': 1, 'pending': 1})

    def test_observed_downloads_are_reported_without_a_metadata_table(self):
        with fixture_database(self.paths['desktop']) as db:
            for state, at in [('started','2026-10-01T00:00:00Z'), ('completed','2026-10-01T00:01:00Z')]:
                props = json.dumps({'attempt_id':'private-attempt','state':state,'duration':'10-60s','reason':'none'})
                db.execute('INSERT INTO events VALUES(?,?,?,?,?,?)', ('download_task_state',at,'private-install','s1',at,props))
        original = Path(self.paths['desktop']).read_bytes()
        result = self.collect()
        downloads = result['sources']['desktop']['metrics']['downloads']
        self.assertEqual(downloads['status'], 'recording')
        self.assertEqual(downloads['counts'], {'completed':1})
        self.assertEqual(downloads['observed_starts'], 1)
        self.assertEqual(downloads['complete_rate'], 1)
        self.assertIsNone(downloads['started_at_bj'])
        self.assertEqual(downloads['start_time_source'], 'observed_events')
        self.assertEqual(downloads['first_observed_at_bj'], '2026-10-01T08:00:00+08:00')
        self.assertIn('缺少采集开始标记', report_module.html_report(result))
        self.assertIn('不等于正式接入时间', report_module.html_report(result))
        self.assertIn('不等于正式接入时间', report_module.markdown_report(result))
        self.assertNotIn('服务接入时间：None', report_module.markdown_report(result))
        self.assertNotIn('旧桌面下载结果尚未开始采集', json.dumps(result,ensure_ascii=False))
        self.assertNotIn('private-attempt', json.dumps(result))
        self.assertNotIn('private-install', report_module.html_report(result))
        self.assertEqual(original, Path(self.paths['desktop']).read_bytes())

    def test_empty_or_bad_metadata_does_not_hide_observed_downloads(self):
        with fixture_database(self.paths['desktop']) as db:
            db.execute('CREATE TABLE telemetry_metadata(key,value)')
            props = json.dumps({'attempt_id':'a','state':'failed','duration':'unknown','reason':'disk'})
            db.execute('INSERT INTO events VALUES(?,?,?,?,?,?)', ('download_task_state','2026-10-01T00:00:00Z','d','s','2026-10-01T00:00:00Z',props))
        for marker in [None, 'bad timestamp', '2026-10-03T00:00:00Z']:
            with self.subTest(marker=marker):
                with fixture_database(self.paths['desktop']) as db:
                    db.execute('DELETE FROM telemetry_metadata')
                    if marker:
                        db.execute('INSERT INTO telemetry_metadata VALUES(?,?)', ('download_lifecycle_started_at',marker))
                downloads = self.collect()['sources']['desktop']['metrics']['downloads']
                self.assertEqual(downloads['status'], 'recording')
                self.assertEqual(downloads['counts'], {'failed':1})
                self.assertIsNone(downloads['started_at_bj'])
                self.assertIsNone(downloads['complete_rate'])

    def test_past_observation_keeps_empty_current_window_recording_without_inventing_activity(self):
        with fixture_database(self.paths['desktop']) as db:
            props=json.dumps({'attempt_id':'a','state':'completed','duration':'under_10s','reason':'none'})
            db.execute('INSERT INTO events VALUES(?,?,?,?,?,?)', ('download_task_state','2026-09-24T00:00:00Z','d','s','2026-09-24T00:00:00Z',props))
        downloads = self.collect()['sources']['desktop']['metrics']['downloads']
        self.assertEqual(downloads['status'], 'recording')
        self.assertEqual(downloads['observed_starts'], 0)
        self.assertEqual(downloads['counts'], {})
        self.assertIsNone(downloads['complete_rate'])
        self.assertEqual(downloads['first_observed_at_bj'], '2026-09-24T08:00:00+08:00')

    def test_future_or_invalid_lifecycle_records_do_not_establish_collection(self):
        with fixture_database(self.paths['desktop']) as db:
            for state, attempt, at in [('started','a','2026-10-03T00:00:00Z'),('unknown','b','2026-10-01T00:00:00Z'),('completed','','2026-10-01T00:00:00Z')]:
                props=json.dumps({'attempt_id':attempt,'state':state,'duration':'unknown','reason':'none'})
                db.execute('INSERT INTO events VALUES(?,?,?,?,?,?)', ('download_task_state',at,'d','s',at,props))
        downloads = self.collect()['sources']['desktop']['metrics']['downloads']
        self.assertEqual(downloads, {'status':'not_instrumented','counts':None})

    def test_agent_downloads_use_geoD_labels_and_export_no_ids(self):
        self.identity['users'][0]['analyticsAudience'] = 'internal'
        self.write_identity()
        with fixture_database(self.paths['agent']) as db:
            db.execute('CREATE TABLE agent_event_metadata(key,value)')
            db.execute("INSERT INTO agent_event_metadata VALUES ('started_at','2026-10-01T00:00:00Z')")
            db.execute('CREATE TABLE agent_events(user_id,event_id,attempt_id,state,duration,reason,occurred_at,received_at)')
            for state in ['started','partial']:
                db.execute('INSERT INTO agent_events VALUES (?,?,?,?,?,?,?,?)', ('geod-user',state,'private-attempt',state,'1-5m','missing_tiles','2026-10-01T02:00:00Z','2026-10-01T02:00:01Z'))
        result = self.collect()
        downloads = result['sources']['agent']['metrics']['download_audiences']
        self.assertEqual(downloads['internal']['counts']['partial'], 1)
        self.assertEqual(downloads['external']['observed_starts'], 0)
        self.assertNotIn('private-attempt', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
