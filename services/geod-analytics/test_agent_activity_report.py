import importlib.util,json,sqlite3,tempfile,unittest
from pathlib import Path
from datetime import datetime,timezone
spec=importlib.util.spec_from_file_location('activity',Path(__file__).with_name('agent_activity_report.py'));report=importlib.util.module_from_spec(spec);spec.loader.exec_module(report)
class ActivityReportTest(unittest.TestCase):
    def test_admin_registry_excludes_unmarked_qa_accounts(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);accounts=root/'accounts.json';ledger=root/'agent.sqlite'
            accounts.write_text(json.dumps({'users':[{'id':'qa','email':'qa@example.test','createdAt':'2026-10-20T00:00:00Z'}]}))
            db=sqlite3.connect(ledger);db.executescript("CREATE TABLE model_generations(user_id,funding_scope,state,created_at);CREATE TABLE agent_events(user_id,state,download_kind,occurred_at);CREATE TABLE agent_telemetry_internal_users(user_id,reason,created_at);INSERT INTO agent_telemetry_internal_users VALUES('qa','internal acceptance','now');INSERT INTO agent_events VALUES('qa','completed','imagery','2026-10-20T01:00:00Z');");db.close()
            result=report.collect(until=datetime(2026,10,21,tzinfo=timezone.utc),accounts=str(accounts),ledger=str(ledger));self.assertEqual(result['new_accounts'],0);self.assertEqual(result['usage_excluding_owner_and_internal']['reported_downloads'],[])
    def test_download_reporting_diagnostic_is_distinct_from_outcome_and_excludes_internal(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);accounts=root/'accounts.json';ledger=root/'agent.sqlite'
            accounts.write_text(json.dumps({'users':[{'id':'a','email':'user@example.test','createdAt':'2026-10-20T00:00:00Z'},{'id':'test','email':'qa@example.test','createdAt':'2026-10-20T00:00:00Z','isTestAccount':True}]}),encoding='utf8')
            db=sqlite3.connect(ledger);db.executescript("CREATE TABLE model_generations(user_id,funding_scope,state,created_at);CREATE TABLE agent_events(user_id,state,download_kind,occurred_at);CREATE TABLE agent_activity_events(user_id,kind,state,reason,input_tokens,output_tokens,usage_known,occurred_at);INSERT INTO agent_activity_events VALUES('a','download_status','started','consent_disabled',NULL,NULL,0,'2026-10-20T01:00:00Z'),('test','download_status','failed','transport_network',NULL,NULL,0,'2026-10-20T01:00:00Z');");db.close()
            result=report.collect(until=datetime(2026,10,21,tzinfo=timezone.utc),accounts=str(accounts),ledger=str(ledger));item=result['new_user_activity'][0]
            self.assertEqual(item['download_reporting_status']['reason'],'consent_disabled');self.assertEqual(item['reported_downloads'],[])
            rows=result['usage_excluding_owner_and_internal']['download_reporting_diagnostics'];self.assertEqual(len(rows),1);self.assertEqual(rows[0]['reason'],'consent_disabled');self.assertEqual(rows[0]['accounts'],1)
    def test_missing_personal_coverage_is_not_zero_and_owner_is_excluded(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);accounts=root/'accounts.json';ledger=root/'agent.sqlite'
            accounts.write_text(json.dumps({'users':[{'id':'a','email':'newuser@example.test','createdAt':'2026-10-20T00:00:00Z'},{'id':'owner','email':'1804287165@qq.com','createdAt':'2026-10-20T00:00:00Z'}],'geodOAuthGrants':[{'userId':'a','clientId':'geod-agent-desktop','accessHash':'private-secret'}]}),encoding='utf8')
            db=sqlite3.connect(ledger);db.executescript('CREATE TABLE model_generations(user_id,funding_scope,state,created_at); CREATE TABLE agent_events(user_id,state,download_kind,occurred_at);');db.close()
            kwargs=dict(until=datetime(2026,10,21,tzinfo=timezone.utc),accounts=str(accounts),ledger=str(ledger))
            result=report.collect(**kwargs);self.assertEqual(result['new_accounts'],1);item=result['new_user_activity'][0];self.assertTrue(item['agent_authorized']);self.assertIsNone(item['reported_activity']);self.assertFalse(item['personal_activity_collection_available']);self.assertNotIn('private-secret',json.dumps(result))
            db=sqlite3.connect(ledger);db.executescript("CREATE TABLE agent_activity_events(user_id,kind,state,input_tokens,output_tokens,usage_known,occurred_at); INSERT INTO agent_activity_events VALUES('a','personal_model','completed',NULL,NULL,0,'2026-10-20T01:00:00Z'); INSERT INTO agent_events VALUES('a','completed','imagery','2026-10-20T01:00:00Z'); INSERT INTO agent_events VALUES('a','failed','imagery','2026-10-22T01:00:00Z');");db.close()
            result=report.collect(**kwargs);item=result['new_user_activity'][0];self.assertTrue(item['personal_activity_collection_available']);self.assertEqual(item['reported_activity'][0]['unknown_usage_events'],1);self.assertIsNone(item['reported_activity'][0]['input_tokens']);self.assertEqual(item['reported_downloads'][0]['attempts'],1)
if __name__=='__main__':unittest.main()
