"""Create authored scan fixtures; no user image is modified or sent anywhere."""
from pathlib import Path
import hashlib
import json
import secrets
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

repo = Path(__file__).resolve().parents[1]
root = repo / 'artifacts/product-gaps-20261004/document-ocr'
workspace = root / 'workspace'
workspace.mkdir(parents=True, exist_ok=True)
manifest_file = root / 'fixtures.json'
assert not manifest_file.exists(), 'Refusing to replace accepted scan fixtures'
alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
markers = {language: 'MAPDATA'+''.join(secrets.choice(alphabet) for _ in range(12))
           for language in ['en', 'zh', 'native']}
font_en = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 48)
font_zh = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 48)
images = {}
for language, lines in {
    'en': ['GeoD scan input acceptance', 'City: Beijing', 'Zoom: 12',
           'West: 116.10   South: 39.10', 'East: 116.20   North: 39.20',
           'Marker: '+markers['en']],
    'zh': ['扫描文档实际验收', '城市：北京市', '缩放级别：12',
           '数据格式：GeoTIFF', '边界范围：116.10，39.10，116.20，39.20',
           'Marker: '+markers['zh']],
}.items():
    image = Image.new('RGB', (1800, 1100), 'white')
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        draw.text((100, 100+index*120), line,
                  font=font_zh if language == 'zh' and index < 5 else font_en, fill='black')
    file = workspace / f'scan-{language}.png'; image.save(file); images[language] = file
    if language == 'en':
        image.save(workspace / 'scan-en.jpg', quality=95)
        image.save(workspace / 'scan-en.webp', lossless=True)
        image.save(workspace / 'scan-en.bmp')

def pdf(file, pages):
    document = canvas.Canvas(str(file), pagesize=(900, 550))
    for page in pages:
        if page == 'native':
            document.setFont('Helvetica', 18)
            document.drawString(50, 480, 'Native PDF text must remain unchanged.')
            document.drawString(50, 430, markers['native'])
        elif page != 'blank':
            document.drawImage(str(images[page]), 0, 0, width=900, height=550)
        document.showPage()
    document.save()

pdf(workspace / 'scan-en.pdf', ['en']); pdf(workspace / 'scan-zh.pdf', ['zh'])
pdf(workspace / 'mixed-pages.pdf', ['native', 'en', 'zh']); pdf(workspace / 'blank.pdf', ['blank'])
with Image.open(images['en']) as first, Image.open(images['zh']) as second:
    first.save(workspace / 'scan-multipage.tiff', save_all=True, append_images=[second], compression='tiff_deflate')
import sys
sys.path.insert(0, str(repo / 'apps/geod-agent-desktop/src-tauri/resources/documents'))
from pypdf import PdfReader, PdfWriter
for name in ['scan-en.pdf', 'scan-zh.pdf']:
    assert all(not page.extract_text() for page in PdfReader(workspace / name).pages), 'Scan must have no embedded text'
writer = PdfWriter(); writer.append(PdfReader(workspace / 'scan-en.pdf')); writer.encrypt('qa-local-password')
writer.write(workspace / 'encrypted-scan.pdf')
(workspace / 'damaged.pdf').write_bytes(b'This is not a PDF document')
(workspace / 'damaged.png').write_bytes(b'This is not an image document')
manifest = {'markers': markers, 'authoredOnly': True, 'files': {
    file.name: {'path': str(file), 'bytes': file.stat().st_size,
                'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
    for file in sorted(workspace.iterdir()) if file.is_file()}}
manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'prepared': True, 'files': len(manifest['files']), 'markers': markers}))
