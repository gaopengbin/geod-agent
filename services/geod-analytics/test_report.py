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
