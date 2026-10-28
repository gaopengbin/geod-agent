from pathlib import Path
import tempfile,unittest,json
from release_runtime_review import sha,same_text,verify

class ReviewTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.native=self.root/'apps/geod-agent-desktop/src-tauri';self.folder=self.native/'resources/test';self.folder.mkdir(parents=True);self.before=self.root/'before';self.old=self.before/'test-runtime';self.old.mkdir(parents=True)
  (self.native/'tauri.conf.json').write_text(json.dumps({'bundle':{'resources':{'resources/test/':'test-runtime/'}}}))
 def tearDown(self):self.temp.cleanup()
 def setup_case(self,name,old,new,old_meta=None,new_meta=None):
  (self.old/name).write_bytes(old);(self.folder/name).write_bytes(new)
  a={**(old_meta or {}),'files':{name:sha(self.old/name)}};b={**(new_meta or {}),'files':{name:sha(self.folder/name)}}
  (self.old/'manifest.json').write_text(json.dumps(a));(self.folder/'manifest.json').write_text(json.dumps(b,indent=2))
  freeze=self.root/'freeze.json';freeze.write_text(json.dumps({'files':{},'runtimeInputs':{'runtimes':{'test-runtime':{'manifestSha256':sha(self.old/'manifest.json')}}}}))
  receipt=self.root/'original.json';receipt.write_text(json.dumps({'exitCode':0,'phase':'failed','failure':'Actual build source or runtime inputs changed; candidate review is blocked','changedSources':[],'changedBuildInputs':[],'candidateHasNoPrivateSigningMaterial':True,'frozenAssetsPreserved':True,'preBuildSourceFreeze':str(freeze),'preBuildSourceFreezeSha256':sha(freeze)}));return receipt
 def test_newlines_require_real_utf8_equivalence(self):
  a=self.root/'a';b=self.root/'b';a.write_bytes(b'{"a":1}\r\n');b.write_bytes(b'{"a":1}\n');self.assertTrue(same_text(a,b));b.write_bytes(b'{"a":2}\n');self.assertFalse(same_text(a,b));b.write_bytes(b'\0');self.assertFalse(same_text(a,b))
 def test_accepted_text_is_linked_to_the_original_failed_freeze(self):
  r=self.setup_case('runtime.json',b'{"a":1}\r\n',b'{"a":1}\n');p=verify(self.root,r,self.before);self.assertTrue(p['passed']);self.assertEqual(p['details'][0]['newlineOnlyFiles'],['runtime.json'])
 def test_executable_changes_are_rejected_even_with_updated_manifests(self):
  r=self.setup_case('node.exe',b'old',b'new')
  with self.assertRaises(AssertionError):verify(self.root,r,self.before)
 def test_configuration_value_changes_are_rejected(self):
  r=self.setup_case('runtime.json',b'{"a":1}\r\n',b'{"a":2}\n')
  with self.assertRaises(AssertionError):verify(self.root,r,self.before)
 def test_unexplained_manifest_metadata_changes_are_rejected(self):
  r=self.setup_case('runtime.json',b'{}',b'{}',{'version':'1'},{'version':'2'})
  with self.assertRaises(AssertionError):verify(self.root,r,self.before)

if __name__=='__main__':unittest.main()
