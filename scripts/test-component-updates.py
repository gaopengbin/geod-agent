"""Archive compatibility, path safety and backward-compatible release metadata."""
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from component_updates import archive_runtime, bundle_application, package_components


class ComponentUpdates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def runtime(self, name='source'):
        root = self.root / name
        root.mkdir()
        (root / 'engine.bin').write_bytes(b'actual runtime')
        (root / 'manifest.json').write_text(json.dumps({'files': {'engine.bin': hashlib.sha256(b'actual runtime').hexdigest()}}), encoding='utf-8')
        return root

    def test_archives_are_repeatable_and_only_include_verified_manifest_files(self):
        source = self.runtime()
        (source / 'unlisted-key.txt').write_text('never package me')
        first, second = self.root / 'first.tar.gz', self.root / 'second.tar.gz'
        sha, size = archive_runtime(source, first)
        archive_runtime(source, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(sha, hashlib.sha256((source / 'manifest.json').read_bytes()).hexdigest())
        with tarfile.open(first) as archive:
            self.assertEqual(set(archive.getnames()), {'engine.bin', 'manifest.json'})
            self.assertEqual(sum(member.size for member in archive), size)

    def test_damaged_source_is_rejected_before_packaging(self):
        source = self.runtime()
        (source / 'engine.bin').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            archive_runtime(source, self.root / 'bad.tar.gz')

    def test_application_bundle_replaces_resource_map_and_restores_full_installer(self):
        desktop = self.root / 'apps/geod-agent-desktop'
        release = desktop / 'src-tauri/target/release'
        installer = release / 'bundle/nsis/GeoD Agent_0.2.5_x64-setup.exe'
        installer.parent.mkdir(parents=True)
        installer.write_bytes(b'full payload')
        (release / 'geod-agent-desktop.exe').write_bytes(b'new compiled app')
        (desktop / 'src-tauri/tauri.conf.json').write_text('{"version":"0.2.5"}')
        output = self.root / 'output'
        output.mkdir()
        configs = []

        def run(args, **kwargs):
            config = json.loads(Path(args[-1]).read_text())
            configs.append(config)
            self.assertIsInstance(config['bundle']['resources'], list)
            self.assertNotIn('TAURI_SIGNING_PRIVATE_KEY', kwargs['env'])
            installer.write_bytes(b'small app payload')

        original = {'bundle': {'windows': {'nsis': {'compression': 'lzma'}}}}
        with patch('component_updates.subprocess.run', side_effect=run):
            file = bundle_application(self.root, output, {'PATH': 'fixture'}, original)
        self.assertEqual(file.read_bytes(), b'small app payload')
        self.assertEqual(installer.read_bytes(), b'full payload')
        self.assertNotIn('resources', original['bundle'])

    def test_signed_index_preserves_legacy_full_url_and_signs_all_components(self):
        output = self.root / 'output'
        output.mkdir()
        app = output / 'application.exe'
        app.write_bytes(b'new app')
        (output / 'latest.json').write_text(json.dumps({'version': '0.2.5', 'platforms': {'windows-x86_64': {'url': 'https://example.test/full.exe', 'signature': 'full signature'}}}))
        from component_updates import IDS
        sources = [(self.runtime(id), id) for id in sorted(IDS)]
        signed_files = []

        def sign(file, version):
            self.assertEqual(version, '0.2.5')
            signed_files.append(file.name)
            Path(str(file) + '.sig').write_text('version-bound signature')

        with patch('component_updates.runtime_directories', return_value=sources):
            receipt = package_components(self.root, output, app, '0.2.5', 'https://example.test/0.2.5', sign)
        manifest = json.loads((output / 'latest.json').read_text())
        self.assertEqual(manifest['platforms']['windows-x86_64']['url'], 'https://example.test/full.exe')
        self.assertTrue(manifest['componentUpdate']['url'].endswith('/component-update.json'))
        self.assertEqual(len(signed_files), 8)
        self.assertEqual(receipt['unchangedRuntimesDownloadBytes'], 0)


if __name__ == '__main__':
    unittest.main()
