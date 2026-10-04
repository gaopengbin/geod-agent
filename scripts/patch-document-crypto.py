"""Versioned MS-OFFCRYPTO padding fixes for the checksum-pinned 6.0.0 wheel.

The upstream verifier compares a SHA-1 digest with its AES-padded bytes. These
changes retain password and payload verification for independently written
AES-128/SHA-1 and AES-192 packages. Original package licenses are preserved.
"""
from pathlib import Path
import hashlib

def patch_document_crypto(root):
    edits={
        'msoffcrypto/method/ecma376_agile.py':(
            '2bc16bc3df67336885926a679ee72312852100de25266cd96a0749dcb74447f2',[
                ('encryption_key = h_final.digest()[: keyBits // 8]', 'encryption_key = _normalize_key(h_final.digest(), keyBits // 8)'),
                ('return acutal_hash == expected_hash', 'return hmac.compare_digest(acutal_hash, expected_hash[:len(acutal_hash)])'),
                ('return hmacValue == actualHmac', 'return hmac.compare_digest(hmacValue[:len(actualHmac)], actualHmac)'),
            ]),
        'msoffcrypto/format/ooxml.py':(
            'eacae5d34b74408b4480b925479965e6b94399b1b9df1c91c75b2a817d25033f',[
                ('    spinValue = int(password_node.getAttribute("spinCount"))', '    for node in [xml.getElementsByTagName("keyData")[0], password_node]:\n        if node.getAttribute("cipherAlgorithm") != "AES" or node.getAttribute("cipherChaining") != "ChainingModeCBC":\n            raise exceptions.DecryptionError("Unsupported Agile cipher mode")\n    spinValue = int(password_node.getAttribute("spinCount"))'),
                ('"keyDataBlockSize": keyDataBlockSize,', '"keyDataBlockSize": keyDataBlockSize,\n        "keyDataKeyBits": int(xml.getElementsByTagName("keyData")[0].getAttribute("keyBits")),'),
                ('        if password:\n', '        if password is not None:\n'),
                ('                if verify_password:\n                    verified = ECMA376Agile.verify_password(', '                self.secret_key = self.secret_key[: self.info["keyDataKeyBits"] // 8]\n                if verify_password:\n                    verified = ECMA376Agile.verify_password('),
            ]),
    }
    result={}
    for name,(expected,replacements) in edits.items():
        file=Path(root)/name
        original=file.read_bytes()
        assert hashlib.sha256(original).hexdigest()==expected,'Unexpected document crypto source: '+name
        text=original.decode('utf-8')
        for old,new in replacements:
            assert text.count(old)==1,'Unexpected document crypto patch context: '+name
            text=text.replace(old,new)
        file.write_text(text,encoding='utf-8',newline='\n')
        result[name]={'originalSha256':expected,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
    return result
