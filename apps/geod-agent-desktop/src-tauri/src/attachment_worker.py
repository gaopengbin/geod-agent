"""Local, read-only document extraction. Never execute macros, links or formulas."""
from pathlib import Path
import contextlib, io, json, logging, math, posixpath, re, sys, zipfile
import xml.etree.ElementTree as ET
sys.dont_write_bytecode = True

MAX_CHARS = 2_000_000
MAX_XML = 24 * 1024 * 1024
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_OCR_PAGES = 50
MAX_IMAGE_PIXELS = 25_000_000
class DocumentError(Exception): pass
def fail(code): raise DocumentError(code)
def clean(text):
    return ''.join(character for character in text if character in '\n\t' or ord(character) >= 32).replace('\r\n', '\n')
class Output:
    def __init__(self): self.parts = []; self.size = 0; self.truncated = False
    def add(self, label, text):
        if not text: return
        value = '\n[' + label + ']\n' + clean(text)
        remaining = MAX_CHARS - self.size
        if len(value) > remaining: self.truncated = True
        value = value[:remaining]
        if value: self.parts.append(value); self.size += len(value)
    def result(self, **metadata): return {'text': '\n'.join(self.parts), 'truncated': self.truncated, **metadata}
def xml(bundle, name):
    try: item = bundle.getinfo(name)
    except KeyError: fail('ATTACHMENT_DOCUMENT_INVALID')
    if item.file_size > MAX_XML: fail('ATTACHMENT_CONTENT_LIMIT')
    data = bundle.read(item)
    # Reject entity declarations explicitly; do not resolve external resources.
    declarations = data.upper().replace(b'\x00', b'')
    if b'<!DOCTYPE' in declarations or b'<!ENTITY' in declarations: fail('ATTACHMENT_DOCUMENT_INVALID')
    try: return ET.fromstring(data)
    except ET.ParseError: fail('ATTACHMENT_DOCUMENT_INVALID')
def local_name(tag): return tag.rsplit('}', 1)[-1]
def texts(node): return ''.join(child.text or '' for child in node.iter() if local_name(child.tag) == 't')
def relationship_id(node): return next((value for key, value in node.attrib.items() if key.endswith('}id')), None)
def part_target(source, target, prefix):
    if not target or ':' in target or '\\' in target: fail('ATTACHMENT_DOCUMENT_INVALID')
    name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(source), target))
    if not name.startswith(prefix) or not name.endswith('.xml') or '..' in name.split('/'): fail('ATTACHMENT_DOCUMENT_INVALID')
    return name
def archive(file):
    try: bundle = zipfile.ZipFile(file)
    except zipfile.BadZipFile: fail('ATTACHMENT_DOCUMENT_INVALID')
    items = bundle.infolist()
    if len(items) > 12000 or sum(item.file_size for item in items) > MAX_ARCHIVE:
        bundle.close(); fail('ATTACHMENT_CONTENT_LIMIT')
    if len({item.filename for item in items}) != len(items) or any(item.flag_bits & 1 for item in items):
        bundle.close(); fail('ATTACHMENT_DOCUMENT_INVALID')
    return bundle
def parse_docx(file):
    output = Output()
    with archive(file) as bundle:
        names = ['word/document.xml'] + sorted(name for name in bundle.namelist() if re.fullmatch(r'word/(?:header\d+|footer\d+|footnotes|endnotes)\.xml', name))
        for name in names:
            tree = xml(bundle, name)
            # Paragraph order includes paragraphs within tables and text boxes.
            paragraphs = [''.join((child.text or '') if local_name(child.tag) == 't' else '\t' if local_name(child.tag) == 'tab' else '\n' if local_name(child.tag) in ['br', 'cr'] else '' for child in paragraph.iter()) for paragraph in tree.iter() if local_name(paragraph.tag) == 'p']
            output.add('正文' if name == 'word/document.xml' else name.rsplit('/', 1)[-1], '\n'.join(paragraphs))
            if output.truncated: break
    return output.result(kind='word', units=len(names), unitLabel='parts', warnings=[])
def parse_pptx(file):
    output = Output()
    with archive(file) as bundle:
        presentation = xml(bundle, 'ppt/presentation.xml')
        relationships = {item.get('Id'): item for item in xml(bundle, 'ppt/_rels/presentation.xml.rels')}
        names = []
        for slide in presentation.iter():
            if local_name(slide.tag) != 'sldId': continue
            relationship = relationships.get(relationship_id(slide))
            if relationship is None or relationship.get('TargetMode') == 'External': fail('ATTACHMENT_DOCUMENT_INVALID')
            names.append(part_target('ppt/presentation.xml', relationship.get('Target'), 'ppt/slides/'))
        if not names: fail('ATTACHMENT_DOCUMENT_INVALID')
        for index, name in enumerate(names, 1):
            tree = xml(bundle, name)
            output.add('Slide ' + str(index), '\n'.join(texts(node) for node in tree.iter() if local_name(node.tag) == 'p'))
            relations = posixpath.join(posixpath.dirname(name), '_rels', posixpath.basename(name) + '.rels')
            if relations in bundle.namelist():
                for relationship in xml(bundle, relations):
                    if not relationship.get('Type', '').endswith('/notesSlide') or relationship.get('TargetMode') == 'External': continue
                    notes = part_target(name, relationship.get('Target'), 'ppt/notesSlides/')
                    output.add('Notes ' + str(index), '\n'.join(texts(node) for node in xml(bundle, notes).iter() if local_name(node.tag) == 'p'))
            if output.truncated: break
    return output.result(kind='presentation', units=len(names), unitLabel='slides', warnings=[])
def parse_xlsx(file):
    output = Output(); sheet_names = []; formulas = False
    with archive(file) as bundle:
        strings = []
        if 'xl/sharedStrings.xml' in bundle.namelist(): strings = [texts(node) for node in xml(bundle, 'xl/sharedStrings.xml') if local_name(node.tag) == 'si']
        workbook = xml(bundle, 'xl/workbook.xml')
        relationships = {item.get('Id'): item.get('Target') for item in xml(bundle, 'xl/_rels/workbook.xml.rels')}
        sheets = [node for node in workbook.iter() if local_name(node.tag) == 'sheet']
        for sheet in sheets:
            label = sheet.get('name') or 'Sheet'; sheet_names.append(label)
            relationship = relationship_id(sheet)
            target = relationships.get(relationship) or ''
            name = part_target('xl/workbook.xml', target, 'xl/worksheets/')
            tree = xml(bundle, name); lines = []
            for row in tree.iter():
                if local_name(row.tag) != 'row': continue
                values = []
                for cell in row:
                    if local_name(cell.tag) != 'c': continue
                    children = {local_name(child.tag): child for child in cell}
                    value = children.get('v'); text = value.text or '' if value is not None else ''
                    if cell.get('t') == 's':
                        try: text = strings[int(text)]
                        except (ValueError, IndexError): fail('ATTACHMENT_DOCUMENT_INVALID')
                    elif cell.get('t') == 'inlineStr': text = texts(cell)
                    elif cell.get('t') == 'b': text = 'TRUE' if text == '1' else 'FALSE'
                    formula = children.get('f')
                    if formula is not None:
                        formulas = True; text = (text + ' ' if text else '') + '[formula: ' + (formula.text or '') + ']'
                    if text: values.append((cell.get('r') or '?') + ': ' + text)
                if values: lines.append(' | '.join(values))
                if sum(map(len, lines[-100:])) > MAX_CHARS or len(lines) > 100000: fail('ATTACHMENT_CONTENT_LIMIT')
            output.add(label, '\n'.join(lines))
            if output.truncated: break
    return output.result(kind='spreadsheet', units=len(sheets), unitLabel='sheets', sheets=sheet_names, warnings=['FORMULAS_NOT_RECALCULATED'] if formulas else [])
class LocalOcr:
    """Only local images and pinned local models enter this CPU engine."""
    def __init__(self, modules, runtime=None):
        root = Path(runtime) if runtime else next((candidate for candidate in
            [modules.parent / 'ocr', modules.parent / 'ocr-runtime']
            if (candidate / 'manifest.json').is_file()), modules.parent / 'ocr')
        if not (root / 'manifest.json').is_file(): fail('ATTACHMENT_OCR_RUNTIME')
        sys.path.insert(0, str(root))
        self.root = root; self.engine = None; self.low_confidence = False
        self.pages = []; self.skipped = []

    def recognize(self, image, page):
        from PIL import ImageStat
        if max(ImageStat.Stat(image.convert('RGB')).stddev) < 1: return ''
        if self.engine is None:
            from rapidocr import RapidOCR
            models = self.root / 'rapidocr/models'
            paths = {name: models / model for name, model in {
                'Det.model_path': 'PP-OCRv6_det_small.onnx',
                'Rec.model_path': 'PP-OCRv6_rec_small.onnx',
                'Cls.model_path': 'ch_ppocr_mobile_v2.0_cls_mobile.onnx'}.items()}
            if not all(path.is_file() for path in paths.values()): fail('ATTACHMENT_OCR_RUNTIME')
            with contextlib.redirect_stdout(sys.stderr):
                self.engine = RapidOCR(params={**{key: str(value) for key, value in paths.items()},
                    'Global.log_level': 'critical',
                    'EngineConfig.onnxruntime.intra_op_num_threads': 4,
                    'EngineConfig.onnxruntime.inter_op_num_threads': 1,
                    'EngineConfig.onnxruntime.use_cuda': False,
                    'EngineConfig.onnxruntime.use_dml': False})
        with contextlib.redirect_stdout(sys.stderr): result = self.engine(image)
        text = '\n'.join(result.txts or ())
        if text:
            self.pages.append(page)
            if any(score < 0.8 for score in (result.scores or ())): self.low_confidence = True
        return text

    def metadata(self):
        warnings = []
        if self.low_confidence: warnings.append('OCR_LOW_CONFIDENCE')
        if self.skipped: warnings.append('OCR_PAGE_LIMIT')
        return {'ocrPages': self.pages or None,
                'ocrEngine': 'RapidOCR PP-OCRv6 / CPU' if self.pages else None,
                'warnings': warnings}

def page_needs_ocr(page, text):
    if not text.strip(): return True
    if len(text.strip()) >= 200: return False
    try:
        objects = page.get('/Resources', {}).get('/XObject', {})
        objects = objects.get_object() if hasattr(objects, 'get_object') else objects
        for value in objects.values():
            value = value.get_object()
            if value.get('/Subtype') == '/Image' and int(value.get('/Width', 0))*int(value.get('/Height', 0)) >= 200_000:
                return True
    except (AttributeError, TypeError, ValueError): pass
    return False

def parse_pdf(file, modules, runtime=None, password=None):
    sys.path.insert(0, str(modules)); logging.getLogger('pypdf').setLevel(logging.ERROR)
    from pypdf import PdfReader, overwrite_configuration
    overwrite_configuration(zlib_maximum_output_length=16_000_000,lzw_maximum_output_length=16_000_000,run_length_maximum_output_length=16_000_000,array_based_stream_maximum_output_length=16_000_000)
    output = Output(); reader = None; rendered = None; ocr = None; attempts = 0
    try:
        reader = PdfReader(file, strict=False)
        encrypted=reader.is_encrypted
        if encrypted and not reader.decrypt(password if password is not None else ''):
            fail('ATTACHMENT_PASSWORD_INCORRECT' if password is not None else 'ATTACHMENT_PASSWORD_REQUIRED')
        if len(reader.pages) > 1000: fail('ATTACHMENT_CONTENT_LIMIT')
        for index, page in enumerate(reader.pages, 1):
            # pypdf also caps decompressed streams; retain a smaller processing bound.
            contents = page.get_contents()
            if contents and len(contents.get_data()) > 12 * 1024 * 1024: fail('ATTACHMENT_CONTENT_LIMIT')
            text = page.extract_text() or ''
            if page_needs_ocr(page, text):
                if ocr is None: ocr = LocalOcr(modules, runtime)
                if attempts >= MAX_OCR_PAGES:
                    ocr.skipped.append(index); output.truncated = True
                else:
                    attempts += 1
                    import pypdfium2 as pdfium
                    if rendered is None: rendered = pdfium.PdfDocument(file,password=password)
                    pdf_page = rendered.get_page(index-1)
                    try:
                        width, height = pdf_page.get_size()
                        if not all(math.isfinite(value) and value > 0 for value in [width, height]): fail('ATTACHMENT_DOCUMENT_INVALID')
                        scale = min(2.5, 2600/max(width, height), math.sqrt(6_000_000/(width*height)))
                        bitmap = pdf_page.render(scale=scale, rev_byteorder=True)
                        try:
                            image = bitmap.to_pil().convert('RGB')
                            try: recognized = ocr.recognize(image, index)
                            finally: image.close()
                        finally: bitmap.close()
                    finally: pdf_page.close()
                    if len(recognized.strip()) >= len(text.strip()): text = recognized or text
                    elif index in ocr.pages: ocr.pages.remove(index)
            output.add('Page ' + str(index), text)
            if output.truncated: break
        metadata = ocr.metadata() if ocr else {'warnings': []}
        if not output.parts: metadata['warnings'].append('SCANNED_OR_EMPTY_PDF')
        return output.result(kind='pdf', units=len(reader.pages), unitLabel='pages', wasEncrypted=encrypted, **metadata)
    except DocumentError: raise
    except NotImplementedError: fail('ATTACHMENT_PASSWORD_UNSUPPORTED')
    except Exception: fail('ATTACHMENT_DOCUMENT_INVALID')
    finally:
        if rendered: rendered.close()
        if reader: reader.close()

def parse_scan_image(file, modules, runtime=None):
    ocr = LocalOcr(modules, runtime)
    from PIL import Image, ImageOps
    output = Output()
    try:
        with Image.open(file) as source:
            units = getattr(source, 'n_frames', 1)
            for index in range(min(units, MAX_OCR_PAGES)):
                source.seek(index)
                if source.width*source.height > MAX_IMAGE_PIXELS: fail('ATTACHMENT_CONTENT_LIMIT')
                corrected = ImageOps.exif_transpose(source)
                try: image = corrected.convert('RGB')
                finally: corrected.close()
                try:
                    image.thumbnail((2600, 2600))
                    output.add('Page '+str(index+1), ocr.recognize(image, index+1))
                finally: image.close()
                if output.truncated: break
            if units > MAX_OCR_PAGES: output.truncated = True; ocr.skipped = list(range(MAX_OCR_PAGES+1, units+1))
        metadata = ocr.metadata()
        if not output.parts: metadata['warnings'].append('OCR_NO_TEXT')
        return output.result(kind='scan', units=units, unitLabel='pages', **metadata)
    except DocumentError: raise
    except Image.DecompressionBombError: fail('ATTACHMENT_CONTENT_LIMIT')
    except Exception: fail('ATTACHMENT_DOCUMENT_INVALID')

class DecryptedBuffer(io.BytesIO):
    def write(self,data):
        if self.tell()+len(data)>32*1024*1024: fail('ATTACHMENT_CONTENT_LIMIT')
        return super().write(data)

def parse_office(file, extension, modules, password=None):
    parser={'docx':parse_docx,'xlsx':parse_xlsx,'pptx':parse_pptx}[extension]
    with open(file,'rb') as source:
        if source.read(8)!=b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1': return parser(file)
        source.seek(0);sys.path.insert(0,str(modules))
        from msoffcrypto import OfficeFile,exceptions
        try:
            protected=OfficeFile(source)
            if protected.format!='ooxml': fail('ATTACHMENT_DOCUMENT_INVALID')
            if not protected.is_encrypted(): fail('ATTACHMENT_DOCUMENT_INVALID')
            if protected.type not in ['agile','standard']: fail('ATTACHMENT_PASSWORD_UNSUPPORTED')
            if password is None: fail('ATTACHMENT_PASSWORD_REQUIRED')
            protected.load_key(password=password,verify_password=True)
            with DecryptedBuffer() as decrypted:
                try: protected.decrypt(decrypted,verify_integrity=True)
                except exceptions.InvalidKeyError: fail('ATTACHMENT_DOCUMENT_INVALID')
                decrypted.seek(0);value=parser(decrypted);value['wasEncrypted']=True;return value
        except DocumentError: raise
        except exceptions.InvalidKeyError: fail('ATTACHMENT_PASSWORD_INCORRECT')
        except exceptions.DecryptionError: fail('ATTACHMENT_PASSWORD_UNSUPPORTED')
        except Exception: fail('ATTACHMENT_DOCUMENT_INVALID')

def parse(file, extension, modules, runtime=None, password=None):
    if extension == 'pdf': return parse_pdf(file, modules, runtime, password)
    if extension in ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff']: return parse_scan_image(file, modules, runtime)
    if extension in ['docx','xlsx','pptx']: return parse_office(file, extension, modules, password)
    if extension not in ['txt', 'md', 'csv', 'json', 'xml', 'log']: fail('ATTACHMENT_FORMAT')
    data = Path(file).read_bytes(); text = None
    for encoding in (['utf-16'] if data.startswith((b'\xff\xfe', b'\xfe\xff')) else ['utf-8-sig', 'gb18030']):
        try: text = data.decode(encoding); break
        except UnicodeDecodeError: pass
    if text is None or '\x00' in text: fail('ATTACHMENT_DOCUMENT_INVALID')
    text = clean(text)
    return {'text': text[:MAX_CHARS], 'truncated': len(text) > MAX_CHARS, 'kind': 'text', 'units': 1, 'unitLabel': 'files', 'warnings': []}
if __name__ == '__main__':
    try:
        arguments=[argument for argument in sys.argv[1:] if argument!='--password-stdin'];password=None
        if '--password-stdin' in sys.argv[1:]:
            data=sys.stdin.buffer.read(32769)
            if len(data)>32768: fail('ATTACHMENT_PASSWORD_INPUT')
            request=json.loads(data)
            password=request.get('password')
            if password is not None and (not isinstance(password,str) or len(password.encode('utf-8'))>4096): fail('ATTACHMENT_PASSWORD_INPUT')
        value = parse(Path(arguments[0]), arguments[1], Path(arguments[2]), arguments[3] if len(arguments)>3 else None, password); print(json.dumps({'ok': True, **value}, ensure_ascii=False))
    except DocumentError as error: print(json.dumps({'ok': False, 'error': str(error)})); sys.exit(1)
    except Exception: print(json.dumps({'ok': False, 'error': 'ATTACHMENT_DOCUMENT_INVALID'})); sys.exit(1)
