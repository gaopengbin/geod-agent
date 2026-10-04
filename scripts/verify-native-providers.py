"""Real DeepSeek behind local Claude/Gemini wire fixtures; no invented answers.

Fixture signatures verify lossless protocol replay, not provider cryptography.
Only this process receives the existing authorized upstream credential.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.parse import urlparse
import argparse, base64, hashlib, json, os, secrets, subprocess, sys, threading, time

parser = argparse.ArgumentParser()
parser.add_argument('--existing-geod-config', action='store_true')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
output = repo / 'artifacts/product-gaps-20261004/native-providers'
output.mkdir(parents=True, exist_ok=True)
key = os.environ.get('GEOD_QA_DEEPSEEK_KEY') or os.environ.get('DEEPSEEK_API_KEY')
if not key and args.existing_geod_config:
    skill = Path.home() / '.codex/skills/laogao-tencent-deploy'
    result = subprocess.run(['ssh.exe', '-i', str(Path.home() / '.ssh/laogao_tencent_ed25519'), '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no', '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={skill / "references/known_hosts"}', '-o', 'ConnectTimeout=15', 'ubuntu@62.234.147.130', 'sudo cat /srv/laogao/secrets/geod-agent.env'], capture_output=True, encoding='utf-8', timeout=30)
    if result.returncode:
        raise SystemExit('Existing authorized test credential unavailable; no server changes made')
    for line in result.stdout.splitlines():
        name, sep, value = line.partition('=')
        if sep and name.strip() == 'DEEPSEEK_API_KEY':
            key = value.strip().strip('"').strip("'")
    del result
if not key:
    raise SystemExit('An authorized process-only upstream key is required')

fixture_key = secrets.token_hex(24)
records, signatures = [], {}
lock = threading.Lock()
started = time.time()

def signed(part):
    signature = 'local-wire-fixture-' + secrets.token_hex(20)
    with lock:
        signatures[signature] = json.loads(json.dumps(part))
    return signature

def validate(part, field):
    signature = part.get(field)
    if not signature:
        return 0
    original = {k: v for k, v in part.items() if k != field}
    with lock:
        expected = signatures.get(signature)
    if expected != original:
        raise ValueError('NATIVE_SIGNED_STATE_REPLAY_CHANGED')
    return 1

def decode(protocol, body):
    messages, tools, replayed = [], [], 0
    if protocol == 'anthropic':
        system = body.get('system', [])
        if system:
            messages.append({'role': 'system', 'content': system if isinstance(system, str) else '\n'.join(p['text'] for p in system)})
        for message in body['messages']:
            content, thought, calls, results = [], [], [], []
            parts = message['content'] if isinstance(message['content'], list) else [{'type': 'text', 'text': message['content']}]
            for part in parts:
                kind = part['type']
                if kind == 'text': content.append(part['text'])
                elif kind == 'thinking':
                    replayed += validate(part, 'signature'); thought.append(part['thinking'])
                elif kind == 'tool_use':
                    calls.append({'id': part['id'], 'type': 'function', 'function': {'name': part['name'], 'arguments': json.dumps(part['input'], ensure_ascii=False)}})
                elif kind == 'tool_result':
                    results.append({'role': 'tool', 'tool_call_id': part['tool_use_id'], 'content': part['content'] if isinstance(part['content'], str) else json.dumps(part['content'], ensure_ascii=False)})
                else: raise ValueError('FIXTURE_INPUT_TYPE_UNSUPPORTED')
            if content or calls or thought:
                value = {'role': message['role'], 'content': '\n'.join(content)}
                if calls: value['tool_calls'] = calls
                if thought: value['reasoning_content'] = ''.join(thought)
                messages.append(value)
            messages.extend(results)
        tools = [{'type': 'function', 'function': {'name': t['name'], 'description': t.get('description', ''), 'parameters': t['input_schema']}} for t in body.get('tools', [])]
        limit = body['max_tokens']
    else:
        system = body.get('systemInstruction', {}).get('parts', [])
        if system: messages.append({'role': 'system', 'content': '\n'.join(p['text'] for p in system)})
        pending = []
        for message in body['contents']:
            content, thought, calls, results = [], [], [], []
            for part in message['parts']:
                replayed += validate(part, 'thoughtSignature')
                if 'text' in part: (thought if part.get('thought') else content).append(part['text'])
                if 'functionCall' in part:
                    call = part['functionCall']
                    call_id = call.get('id') or 'call_' + hashlib.sha256(json.dumps(call, sort_keys=True).encode()).hexdigest()[:24]
                    pending.append((call['name'], call_id))
                    calls.append({'id': call_id, 'type': 'function', 'function': {'name': call['name'], 'arguments': json.dumps(call.get('args', {}), ensure_ascii=False)}})
                if 'functionResponse' in part:
                    response = part['functionResponse']
                    index = next(i for i, (name, _) in enumerate(pending) if name == response['name'])
                    _, call_id = pending.pop(index)
                    results.append({'role': 'tool', 'tool_call_id': response.get('id') or call_id, 'content': json.dumps(response['response'], ensure_ascii=False)})
            if content or calls or thought:
                value = {'role': 'assistant' if message['role'] == 'model' else 'user', 'content': ''.join(content)}
                if calls: value['tool_calls'] = calls
                if thought: value['reasoning_content'] = ''.join(thought)
                messages.append(value)
            messages.extend(results)
        tools = [{'type': 'function', 'function': {'name': t['name'], 'description': t.get('description', ''), 'parameters': t.get('parametersJsonSchema', t.get('parameters', {}))}} for group in body.get('tools', []) for t in group.get('functionDeclarations', [])]
        limit = body['generationConfig']['maxOutputTokens']
    return messages, tools, limit, replayed

def chunks(text, width=96):
    return [text[i:i+width] for i in range(0, len(text), width)]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def reply(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def authorized(self, protocol):
        field = 'x-api-key' if protocol == 'anthropic' else 'x-goog-api-key'
        return self.headers.get(field) == fixture_key and not self.headers.get('Authorization') and (protocol != 'anthropic' or self.headers.get('anthropic-version') == '2023-06-01') and 'key=' not in self.path

    def do_GET(self):
        protocol = 'anthropic' if self.path.startswith('/anthropic/') else 'gemini'
        if not self.authorized(protocol): return self.reply({'error': {'message': 'Fixture authentication rejected'}}, 401)
        if protocol == 'anthropic': self.reply({'data': [{'id': 'deepseek-flash', 'type': 'model', 'display_name': 'Actual DeepSeek via Claude wire fixture'}]})
        else: self.reply({'models': [{'name': 'models/deepseek-flash', 'supportedGenerationMethods': ['generateContent', 'streamGenerateContent']}]})

    def do_POST(self):
        protocol = 'anthropic' if self.path.startswith('/anthropic/') else 'gemini'
        if not self.authorized(protocol): return self.reply({'error': {'message': 'Fixture authentication rejected'}}, 401)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 32_000_000: raise ValueError('FIXTURE_REQUEST_SIZE')
            body = json.loads(self.rfile.read(length))
            messages, tools, limit, replayed = decode(protocol, body)
            upstream = {'model': 'deepseek-flash', 'messages': messages, 'stream': False, 'max_tokens': limit, 'thinking': {'type': 'enabled'}}
            if tools: upstream.update(tools=tools, parallel_tool_calls=False)
            request = Request('https://api.deepseek.com/v1/chat/completions', data=json.dumps(upstream, ensure_ascii=False).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
            with urlopen(request, timeout=180) as response: actual = json.load(response)
            choice = actual['choices'][0]; message = choice['message']; usage = actual.get('usage', {})
            record = {'protocol': protocol, 'upstream': 'DeepSeek actual request', 'actualModel': actual.get('model'), 'generationId': actual.get('id'), 'replayedSignatureBlocks': replayed, 'messageCount': len(messages), 'toolCalls': [c['function']['name'] for c in message.get('tool_calls', [])], 'usage': usage, 'nativeAuthenticationValidated': True}
            with lock: records.append(record)
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Connection', 'close'); self.end_headers()
            self.close_connection = True
            def event(value):
                data = ('data: ' + json.dumps(value, ensure_ascii=False) + '\r\n\r\n').encode()
                # Split UTF-8 bytes deliberately; native collection must reassemble.
                for i in range(0, len(data), 113): self.wfile.write(data[i:i+113])
                self.wfile.flush()
            reasoning, text, calls = message.get('reasoning_content') or '', message.get('content') or '', message.get('tool_calls', [])
            if protocol == 'anthropic':
                event({'type': 'message_start', 'message': {'id': actual['id'], 'model': actual['model'], 'usage': {'input_tokens': usage.get('prompt_cache_miss_tokens', usage.get('prompt_tokens', 0)), 'cache_read_input_tokens': usage.get('prompt_cache_hit_tokens', 0), 'cache_creation_input_tokens': 0, 'output_tokens': 0}}})
                index = 0
                if reasoning:
                    part = {'type': 'thinking', 'thinking': reasoning}; signature = signed(part)
                    event({'type': 'content_block_start', 'index': index, 'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''}})
                    for chunk in chunks(reasoning): event({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'thinking_delta', 'thinking': chunk}})
                    event({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'signature_delta', 'signature': signature}})
                    event({'type': 'content_block_stop', 'index': index}); index += 1
                if text:
                    event({'type': 'content_block_start', 'index': index, 'content_block': {'type': 'text', 'text': ''}})
                    for chunk in chunks(text): event({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'text_delta', 'text': chunk}})
                    event({'type': 'content_block_stop', 'index': index}); index += 1
                for call in calls:
                    event({'type': 'content_block_start', 'index': index, 'content_block': {'type': 'tool_use', 'id': call['id'], 'name': call['function']['name'], 'input': {}}})
                    for chunk in chunks(call['function']['arguments'], 17): event({'type': 'content_block_delta', 'index': index, 'delta': {'type': 'input_json_delta', 'partial_json': chunk}})
                    event({'type': 'content_block_stop', 'index': index}); index += 1
                event({'type': 'message_delta', 'delta': {'stop_reason': 'max_tokens' if choice.get('finish_reason') == 'length' else 'tool_use' if calls else 'end_turn'}, 'usage': {'output_tokens': usage.get('completion_tokens'), 'output_tokens_details': {'thinking_tokens': usage.get('completion_tokens_details', {}).get('reasoning_tokens')}}})
                event({'type': 'message_stop'})
            else:
                for chunk in chunks(reasoning): event({'responseId': actual['id'], 'modelVersion': actual['model'], 'candidates': [{'index': 0, 'content': {'role': 'model', 'parts': [{'thought': True, 'text': chunk}]}}]})
                for chunk in chunks(text): event({'candidates': [{'index': 0, 'content': {'role': 'model', 'parts': [{'text': chunk}]}}]})
                for call in calls:
                    # Omit native ID to exercise the persisted synthetic-ID map.
                    part = {'functionCall': {'name': call['function']['name'], 'args': json.loads(call['function']['arguments'])}}
                    event({'responseId': actual['id'], 'modelVersion': actual['model'], 'candidates': [{'index': 0, 'content': {'role': 'model', 'parts': [{**part, 'thoughtSignature': signed(part)}]}}]})
                thought_tokens = usage.get('completion_tokens_details', {}).get('reasoning_tokens', 0)
                event({'responseId': actual['id'], 'modelVersion': actual['model'], 'candidates': [{'index': 0, 'finishReason': 'MAX_TOKENS' if choice.get('finish_reason') == 'length' else 'STOP'}], 'usageMetadata': {'promptTokenCount': usage.get('prompt_tokens'), 'candidatesTokenCount': max(0, usage.get('completion_tokens', 0) - thought_tokens), 'thoughtsTokenCount': thought_tokens, 'totalTokenCount': usage.get('total_tokens'), 'cachedContentTokenCount': usage.get('prompt_cache_hit_tokens', 0)}})
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) else type(error).__name__
            with lock: records.append({'protocol': protocol, 'fixtureError': code[:120]})
            self.reply({'error': {'message': 'Native protocol verification fixture failed', 'type': 'fixture_error'}}, 502)

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = dict(os.environ, GEOD_NATIVE_FIXTURE_BASE=f'http://127.0.0.1:{server.server_port}', GEOD_NATIVE_FIXTURE_KEY=fixture_key)
for name in ['GEOD_QA_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY', 'GEOD_QA_LITELLM_KEY', 'LITELLM_MASTER_KEY']: env.pop(name, None)
runtime = repo / 'apps/geod-agent-desktop/src-tauri/resources/codex/node.exe'
try:
    completed = subprocess.run([str(runtime), 'scripts/verify-native-providers.mjs'], cwd=repo, env=env, creationflags=subprocess.CREATE_NO_WINDOW)
finally:
    server.shutdown(); server.server_close()
    (output / 'wire-evidence.json').write_text(json.dumps({'officialClaudeOrGeminiProviderVerified': False, 'realUpstream': 'DeepSeek', 'fixtureSignatureReplayOnly': True, 'records': records}, ensure_ascii=False, indent=2), encoding='utf-8')
violations, checked = [], 0
for root in [output, Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/ai-channels', Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/codex-runtime']:
    if not root.exists(): continue
    for directory, directories, files in os.walk(root):
        directories[:] = [name for name in directories if name not in ['node_modules', '.git', 'skills', 'vendor']]
        for name in files:
            file = Path(directory) / name
            if not file.is_file() or file.stat().st_size > 64 * 1024 * 1024 or (root != output and file.stat().st_mtime < started): continue
            try: data = file.read_bytes()
            except PermissionError: continue
            checked += 1
            if key.encode() in data or fixture_key.encode() in data: violations.append(str(file))
audit = {'passed': not violations, 'filesChecked': checked, 'plaintextCredentialFiles': violations}
(output / 'credential-audit.json').write_text(json.dumps(audit, indent=2), encoding='utf-8')
print(json.dumps({'exitCode': completed.returncode, 'actualUpstreamRequests': len([r for r in records if r.get('generationId')]), 'credentialAudit': audit}))
sys.exit(1 if violations else completed.returncode)
