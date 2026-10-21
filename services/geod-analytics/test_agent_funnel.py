import unittest,tempfile,sqlite3,json
from pathlib import Path
from datetime import datetime,timezone
from agent_funnel import website
class FunnelTest(unittest.TestCase):
 def test_internal_visitor_exclusion_and_legacy_isolation(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'web.sqlite';c=sqlite3.connect(p);c.execute('CREATE TABLE product_events(product,event_name,visitor_id,occurred_at,properties_json)')
   for product,event,visitor,props in [('geod-web','page_view','qa',{'path':'/agent'}),('geod-web','page_view','qa',{'path':'/agent','source':'geod-internal'}),('geod-web','page_view','real',{'path':'/agent'}),('geod-web','download_clicked','real',{'path':'/','version':'3.6.15'}),('other','page_view','foreign',{'path':'/agent'}),('geod-web','download_clicked','real',{'path':'/agent','version':'0.2.9','campaign':'geod-agent-download'})]:
    c.execute('INSERT INTO product_events VALUES(?,?,?,?,?)',(product,event,visitor,'2026-10-20T00:00:00Z',json.dumps(props)))
   c.commit();c.close();r=website(p,datetime(2026,10,19,tzinfo=timezone.utc),datetime(2026,10,21,tzinfo=timezone.utc))
   self.assertEqual(r['page_views'],1);self.assertEqual(r['observed_download_clicks'],1);self.assertEqual(r['marked_internal_visitor_ids_excluded'],1);self.assertIsNone(r['installations_completed'])
 def test_missing_source_is_unknown(self):
  r=website('/does/not/exist',datetime.now(timezone.utc),datetime.now(timezone.utc));self.assertEqual(r['status'],'unavailable');self.assertIsNone(r['observed_download_clicks'])
