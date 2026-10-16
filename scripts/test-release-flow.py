"""Publication safety and resumability regression; no network/real cloud writes."""
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import release_cos as cos
import release_activate as origin
import release_github as github
from release_flow import lock, run, save, sha


class Cloud:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.fail = None
    def get_bucket_versioning(self, **kwargs):
        return {}
    def head_object(self, Bucket, Key):
        self.calls.append(('HEAD', Key))
        if Key not in self.objects:
            class Missing(Exception):
                def get_status_code(self): return 404
            raise Missing()
        return self.objects[Key][1]
    def upload_file(self, **kwargs):
        key = kwargs['Key']
        self.calls.append(('PUT', key))
        if key == self.fail:
            raise RuntimeError('Authorization=private-secret-must-not-leak')
        data = Path(kwargs['LocalFilePath']).read_bytes()
        self.objects[key] = (data, {'Content-Length': str(len(data)), 'Cache-Control': kwargs['CacheControl'],
                                   'x-cos-meta-sha256': kwargs['Metadata']['x-cos-meta-sha256'], 'ETag': 'etag'})
    def get_object(self, Bucket, Key):
        from io import BytesIO
        data = self.objects[Key][0]
        class Body:
            def get_raw_stream(self): return BytesIO(data)
        self.calls.append(('GET', Key))
        return {'Body': Body()}
    def put_object(self, **kwargs):
        data, key = kwargs['Body'], kwargs['Key']
        self.calls.append(('PUT', key))
        self.objects[key] = (data, {'Content-Length': str(len(data)), 'Cache-Control': kwargs['CacheControl']})


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(patch.stopall)
    def plan(self):
        folder = self.root / 'public'
        folder.mkdir()
        latest = self.root / 'latest.json'
        latest.write_text('{"version":"0.2.6"}')
        objects, files = [], []
        for name in ['test.exe', 'test.sig']:
            file = folder / name
            file.write_bytes(b'test-content')
            objects.append({'name': name, 'key': cos.PREFIX + '0.2.6/' + name,
                            'bytes': file.stat().st_size, 'sha256': sha(file), 'cacheControl': cos.IMMUTABLE})
            files.append(str(file))
        file = self.root / 'public-objects.json'
        save(file, {'version': '0.2.6', 'objects': objects, 'cosFiles': files, 'mutableLatest': str(latest)})
        return file
    def upload(self, cloud, file):
        with redirect_stdout(StringIO()):
            return cos.upload_assets(cloud, file, self.root / 'receipt.json')
    def test_cloud_resume_skips_completed_objects(self):
        cloud, file = Cloud(), self.plan()
        self.upload(cloud, file)
        result = self.upload(cloud, file)
        self.assertEqual(result['uploadedBytes'], 0)
        self.assertEqual(len([c for c in cloud.calls if c[0] == 'PUT']), 2)
        self.assertFalse(any(c[0] == 'GET' for c in cloud.calls))
    def test_changed_local_asset_blocks_before_any_write(self):
        cloud, file = Cloud(), self.plan()
        (self.root / 'public/test.exe').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.upload(cloud, file)
        self.assertEqual(cloud.calls, [])
    def test_foreign_directory_blocks_upload(self):
        file = self.plan()
        data = json.loads(file.read_text())
        data['cosFiles'][0] = str(self.root.parent / 'foreign.exe')
        save(file, data)
        with self.assertRaises(ValueError): cos.public_plan(file)
    def test_wrong_key_blocks_upload(self):
        file = self.plan()
        data = json.loads(file.read_text())
        data['objects'][0]['key'] = 'private/secret'
        save(file, data)
        with self.assertRaises(ValueError): cos.public_plan(file)
    def test_remote_size_alone_does_not_allow_skip(self):
        cloud, file = Cloud(), self.plan()
        key = json.loads(file.read_text())['objects'][0]['key']
        cloud.objects[key] = (b'test-content', {'Content-Length': '12'})
        with self.assertRaisesRegex(ValueError, 'Preserve'):
            self.upload(cloud, file)
        self.assertFalse(any(c == ('PUT', key) for c in cloud.calls))
    def test_cloud_failure_redacts_provider_secret(self):
        cloud, file = Cloud(), self.plan()
        cloud.fail = json.loads(file.read_text())['objects'][0]['key']
        with self.assertRaises(ValueError) as error: self.upload(cloud, file)
        self.assertNotIn('private-secret', str(error.exception))
        self.assertFalse(json.loads((self.root / 'receipt.json').read_text())['passed'])
    def test_failed_upload_cannot_activate_index(self):
        cloud, file = Cloud(), self.plan()
        save(self.root / 'receipt.json', {'passed': False})
        with self.assertRaises(ValueError):
            cos.activate_index(cloud, file, self.root/'receipt.json', '0'*64, self.root/'backup.json')
        self.assertFalse(cloud.calls)
    def test_index_backup_and_retry_no_second_write(self):
        cloud, file = Cloud(), self.plan()
        self.upload(cloud, file)
        key, old = cos.PREFIX + 'latest.json', b'{"version":"0.2.5"}'
        cloud.objects[key] = (old, {'Content-Length': str(len(old)), 'Cache-Control': cos.MUTABLE})
        import hashlib
        previous = hashlib.sha256(old).hexdigest()
        result = cos.activate_index(cloud, file, self.root/'receipt.json', previous, self.root/'backup.json')
        self.assertEqual(result['state'], 'activated')
        self.assertEqual((self.root/'backup.json').read_bytes(), old)
        before = list(cloud.calls)
        self.assertEqual(cos.activate_index(cloud, file, self.root/'receipt.json', previous, self.root/'backup.json')['state'], 'already_active')
        self.assertEqual(len([c for c in cloud.calls if c[0] == 'PUT']), len([c for c in before if c[0] == 'PUT']))
        self.assertTrue(all(c[1].endswith('/latest.json') for c in cloud.calls if c[0] == 'GET'))
    def test_previous_index_conflict_preserved(self):
        cloud, file = Cloud(), self.plan()
        self.upload(cloud, file)
        key = cos.PREFIX + 'latest.json'
        cloud.objects[key] = (b'other', {'Content-Length': '5'})
        with self.assertRaises(ValueError):
            cos.activate_index(cloud, file, self.root/'receipt.json', '0'*64, self.root/'backup.json')
        self.assertEqual(cloud.objects[key][0], b'other')
    def test_large_cos_read_refused(self):
        cloud = Cloud()
        cloud.objects['large'] = (b'', {'Content-Length': str(cos.SMALL_LIMIT + 1)})
        with self.assertRaises(ValueError): cos.small_cos_read(cloud, 'large')
        self.assertFalse(any(c[0] == 'GET' for c in cloud.calls))
    def test_public_package_fetch_refused_without_network(self):
        with patch('release_cos.urlopen') as request:
            with self.assertRaises(ValueError):
                cos.verify_small_index('https://download.laogao.xyz/setup.exe', self.root/'index')
            request.assert_not_called()
    def recipe(self):
        (self.root/'input').write_text('one')
        command = [sys.executable, '-c', "from pathlib import Path; Path('output').write_text(Path('input').read_text())"]
        return {'root': str(self.root), 'state': 'artifacts/state', 'steps': [
            {'id': 'copy', 'command': command, 'inputs': ['input'], 'outputs': ['output']}]}
    def test_dry_run_never_executes_or_writes(self):
        recipe = self.recipe()
        with patch('release_flow.subprocess.run') as command:
            self.assertTrue(run(recipe, dry_run=True)['dryRun'])
            command.assert_not_called()
        self.assertFalse((self.root/'artifacts').exists())
    def test_resume_and_input_output_invalidation(self):
        recipe = self.recipe()
        with redirect_stdout(StringIO()):
            run(recipe)
            with patch('release_flow.subprocess.run') as child:
                run(recipe); child.assert_not_called()
            (self.root/'input').write_text('two')
            run(recipe)
            self.assertEqual((self.root/'output').read_text(), 'two')
            (self.root/'output').write_text('corrupt')
            run(recipe)
            self.assertEqual((self.root/'output').read_text(), 'two')
    def test_failure_does_not_reuse_success_receipt(self):
        recipe = self.recipe()
        recipe['steps'][0]['command'] = [sys.executable, '-c', 'raise SystemExit(1)']
        with redirect_stdout(StringIO()), self.assertRaises(ValueError): run(recipe)
        data = json.loads((self.root/'artifacts/state/journal.json').read_text())
        self.assertFalse(data['steps']['copy']['passed'])
    def test_double_publisher_lock_rejected(self):
        with lock(self.root/'guard'):
            with self.assertRaises(OSError):
                with lock(self.root/'guard'): pass
    def test_policy_does_not_allow_package_download_or_delete(self):
        policy = json.loads((Path(__file__).parents[1]/'config/release/cos-publisher-policy.json').read_text())
        for entry in policy['statement']:
            self.assertNotIn('name/cos:DeleteObject', entry['action'])
            if 'name/cos:GetObject' in entry['action']:
                self.assertTrue(all(resource.endswith('/latest.json') for resource in entry['resource']))
    def origin_fixture(self):
        import tarfile
        base = self.root / 'server'
        old, new = base/'releases/geod-website/old', base/'releases/geod-website/new'
        stage, backup = base/'staging/geod-agent-test', base/'backups/geod-agent-test'
        for folder in [old, stage, base/'current', base/'backups', base/'packages/geod-agent-updates/windows-x86_64']:
            folder.mkdir(parents=True, exist_ok=True)
        current = base/'current/geod-website'
        try:
            current.symlink_to(old, target_is_directory=True)
        except OSError as error:
            if getattr(error, 'winerror', None) != 1314:
                raise
            # CI/dev Windows need not enable privileged symlink creation.
            # Simulate only the pointer adapter; tar/hash/backup/file operations
            # still execute on real isolated files. Linux uses real symlinks.
            original_resolve, original_is_symlink = Path.resolve, Path.is_symlink
            current.write_text(str(old))
            def resolve(file, *args, **kwargs):
                return Path(current.read_text()) if file == current else original_resolve(file, *args, **kwargs)
            def is_symlink(file):
                return True if file == current else original_is_symlink(file)
            patch.object(Path, 'resolve', resolve).start()
            patch.object(Path, 'is_symlink', is_symlink).start()
            patch('release_activate.select', side_effect=lambda file, target: file.write_text(str(target))).start()
        manifest = base/'packages/geod-agent-updates/windows-x86_64/latest.json'
        manifest.write_text('{"version":"0.2.5"}')
        (stage/'latest.json').write_text('{"version":"0.2.6"}')
        (old/'index.html').write_text('classic GeoD must be preserved')
        pages = ['agent.html','agent.txt','en/agent.html','en/agent.txt']
        files = {}
        source = self.root/'site'
        for name in pages:
            (old/name).parent.mkdir(parents=True, exist_ok=True)
            (old/name).write_text('old agent')
            (source/name).parent.mkdir(parents=True, exist_ok=True)
            (source/name).write_text('new agent /0.2.6/')
            files[name] = {'bytes': (source/name).stat().st_size, 'sha256':sha(source/name)}
        with tarfile.open(stage/'website-agent.tar.gz','w:gz') as archive:
            for name in files: archive.add(source/name,arcname=name)
        plan = {'version':'0.2.6','pages':pages,'files':files,'previousWebsite':str(old),'website':str(new),
                'backup':str(backup),'previousManifestSha256':sha(manifest),'manifestSha256':sha(stage/'latest.json'),
                'archiveSha256':sha(stage/'website-agent.tar.gz')}
        save(stage/'website-deploy-plan.json',plan)
        return base,stage,old,new,manifest,current
    def test_origin_switch_preserves_classic_site_and_rollback(self):
        base,stage,old,new,manifest,current = self.origin_fixture()
        self.assertTrue(origin.activate(stage,base=base)['passed'])
        self.assertEqual(current.resolve(),new.resolve())
        self.assertEqual((new/'index.html').read_text(),'classic GeoD must be preserved')
        self.assertEqual(origin.activate(stage,base=base)['state'],'activated')
        origin.activate(stage,rollback=True,base=base)
        self.assertEqual(current.resolve(),old.resolve())
        self.assertEqual(json.loads(manifest.read_text())['version'],'0.2.5')
    def test_origin_interrupted_switch_can_resume(self):
        base,stage,old,new,manifest,current = self.origin_fixture()
        with patch('release_activate.select', side_effect=OSError('simulated process interruption')):
            with self.assertRaises(OSError): origin.activate(stage,base=base)
        self.assertEqual(current.resolve(),old.resolve())
        self.assertEqual(json.loads(manifest.read_text())['version'],'0.2.6')
        self.assertTrue(origin.activate(stage,base=base)['passed'])
        self.assertEqual(current.resolve(),new.resolve())
    def test_origin_foreign_manifest_conflict_preserved(self):
        base,stage,old,new,manifest,current = self.origin_fixture()
        manifest.write_text('{"version":"9.0.0"}')
        with self.assertRaises(ValueError): origin.activate(stage,base=base)
        self.assertEqual(current.resolve(),old.resolve())
        self.assertEqual(json.loads(manifest.read_text())['version'],'9.0.0')
    def test_origin_archive_outside_agent_pages_rejected(self):
        base,stage,old,new,manifest,current = self.origin_fixture()
        plan = json.loads((stage/'website-deploy-plan.json').read_text())
        plan['pages'] += ['index.html']
        save(stage/'website-deploy-plan.json',plan)
        with self.assertRaises(ValueError): origin.activate(stage,base=base)
        self.assertEqual(current.resolve(),old.resolve())
    def test_external_website_input_invalidates_cached_step(self):
        recipe = self.recipe()
        ext = self.root/'site.txt'
        ext.write_text('site-one')
        recipe['steps'][0]['externalInputs'] = [str(ext)]
        with redirect_stdout(StringIO()):
            run(recipe)
            ext.write_text('site-two')
            with patch('release_flow.subprocess.run', wraps=__import__('subprocess').run) as child:
                run(recipe)
                self.assertEqual(child.call_count,1)
    def test_github_draft_uploads_only_missing_asset(self):
        file = self.plan()
        plan = json.loads(file.read_text())
        plan['githubFiles'] = plan['cosFiles']
        save(file,plan)
        target = 'a'*40
        names = [Path(p) for p in plan['githubFiles']]
        def asset(p): return {'name':p.name,'size':p.stat().st_size,'digest':'sha256:'+sha(p)}
        state = {'url':'https://github.com/gaopengbin/geod-agent/releases/tag/v0.2.6',
                 'isDraft':True,'isPrerelease':False,'targetCommitish':target,'assets':[asset(names[0])]}
        uploads = []
        def gh(*args):
            if args[0] == 'api': return json.dumps([[{'tag_name':'v0.2.6'}]])
            if args[:2] == ('release','view'): return json.dumps(state)
            if args[:2] == ('release','upload'):
                uploads.extend(args[5:])
                state['assets'].append(asset(names[1]))
                return ''
            raise AssertionError('Unexpected mutating GitHub call')
        with patch('release_github.gh',side_effect=gh):
            github.publish('stage',file,target,file,self.root/'github.json')
            github.publish('stage',file,target,file,self.root/'github.json')
        self.assertEqual(uploads,[str(names[1])])
    def test_github_conflicting_public_asset_is_preserved(self):
        file = self.plan()
        plan = json.loads(file.read_text())
        plan['githubFiles'] = plan['cosFiles']
        save(file,plan)
        target = 'a'*40
        response = {'url':'mock','isDraft':False,'isPrerelease':False,'targetCommitish':target,
                    'assets':[{'name':'test.exe','size':12,'digest':'sha256:wrong'}]}
        with patch('release_github.gh',side_effect=[json.dumps([[{'tag_name':'v0.2.6'}]]),json.dumps(response)]) as gh:
            with self.assertRaisesRegex(ValueError,'Preserve conflicting'):
                github.publish('publish',file,target,file,self.root/'github.json')
            self.assertEqual(gh.call_count,2)


if __name__ == '__main__': unittest.main()
