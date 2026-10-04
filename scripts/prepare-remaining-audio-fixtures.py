"""Encode locally authored speech into the four remaining desktop input formats.

FFmpeg is a fixture generator only, never a product runtime dependency.
"""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import uuid

root = Path(__file__).resolve().parents[1]
target = root / 'artifacts/product-gaps-20261004/audio-codecs'
workspace = target / 'workspace'
workspace.mkdir(parents=True, exist_ok=True)
source = root / 'artifacts/product-gaps-20261004/audio-inputs/workspace/beijing-english.wav'
ffmpeg = shutil.which('ffmpeg')
ffprobe = shutil.which('ffprobe')
assert source.is_file() and ffmpeg and ffprobe
manifest_file = target / 'fixtures.json'
assert not manifest_file.exists(), 'Refusing to replace an existing acceptance fixture set'
formats = [
    ('ogg', 'vorbis', ['-c:a', 'libvorbis', '-q:a', '4']),
    ('webm', 'opus', ['-c:a', 'libopus', '-b:a', '48k']),
    ('aac', 'aac', ['-c:a', 'aac', '-b:a', '64k', '-f', 'adts']),
    ('opus', 'opus', ['-c:a', 'libopus', '-b:a', '48k']),
]
files = []
for extension, codec, arguments in formats:
    file = workspace / f'actual-{extension}-{uuid.uuid4().hex[:16]}.{extension}'
    subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
                    '-i', str(source), '-vn', *arguments, str(file)], check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)
    metadata = json.loads(subprocess.check_output(
        [ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)],
        creationflags=subprocess.CREATE_NO_WINDOW))
    audio = [stream for stream in metadata['streams'] if stream['codec_type'] == 'audio']
    assert len(audio) == 1 and audio[0]['codec_name'] == codec
    files.append({'name': file.name, 'path': str(file), 'extension': extension, 'codec': codec,
                  'bytes': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                  'duration': float(metadata['format']['duration'])})
manifest = {'source': str(source), 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'authoredText': 'Please download the satellite imagery for Beijing. Use zoom level twelve and save it as a Geo TIFF file.',
            'fixtureGeneratorOnly': True, 'files': files}
manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'files': files}))
