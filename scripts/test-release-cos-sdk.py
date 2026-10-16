"""Exercise the pinned SDK header mapping with no cloud request or real key."""
import json
from types import SimpleNamespace
from unittest.mock import patch
from release_cos import client_from_environment, BUCKET

with patch.dict('os.environ', {'COS_SECRET_ID':'local-test-id', 'COS_SECRET_KEY':'local-test-placeholder'}):
    client = client_from_environment()
    with patch.object(client, 'send_request', return_value=SimpleNamespace(
            headers={'ETag':'mock'}, content=b'<CompleteMultipartUploadResult><ETag>mock</ETag></CompleteMultipartUploadResult>')) as request:
        client.complete_multipart_upload(Bucket=BUCKET, Key='agent-updates/windows-x86_64/0.2.6/test.exe',
                                         UploadId='local-test', MultipartUpload={'Part':[{'PartNumber':1,'ETag':'mock'}]})
        assert request.call_args.kwargs['headers']['x-cos-forbid-overwrite'] == 'true'
        assert request.call_args.kwargs['method'] == 'POST'
print(json.dumps({'passed':True,'sdk':'1.9.44','noOverwriteCompletionHeader':True,'networkRequests':0}))
