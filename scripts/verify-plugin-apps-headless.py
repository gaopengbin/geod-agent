"""Validate actual companion discovery results, including unavailable App IDs."""
import json
from pathlib import Path

root = Path('artifacts/product-gaps-20261004/plugin-apps')
saved = json.loads((root/'restart-state.json').read_text(encoding='utf-8'))
actual = json.loads((root/'actual-background-model.json').read_text(encoding='utf-8'))
assert actual['run']['state'] == 'succeeded'
items = [event['params']['item'] for event in actual['events'] if event.get('method') == 'item/completed' and event['params']['item'].get('type') == 'dynamicToolCall']
reads = [item for item in items if item.get('tool') == 'extensions_list' and item.get('success') is True]
notes = next(item for item in reads if saved['notesId'] in item['arguments'].get('query', ''))
calendar = next(item for item in reads if saved['calendarId'] in item['arguments'].get('query', ''))
notes_result = json.loads(next(value['text'] for value in notes['contentItems'] if 'text' in value))
calendar_result = json.loads(next(value['text'] for value in calendar['contentItems'] if 'text' in value))
assert any(app['registeredId'] == saved['notesId'] and app['route'] == 'bundledMcp' and app['enabled'] for app in notes_result['registeredApps'])
assert any(connector['connectorId'] == saved['connectors']['notes']['id'] and any(tool['name'] == 'read_context' for tool in connector['tools']) for connector in notes_result['connectors'])
assert calendar_result['registeredApps'] and all(app['route'] == 'unavailable' for app in calendar_result['registeredApps'])
assert not any(connector['connectorId'] == saved['connectors']['notes']['id'] for connector in calendar_result['connectors'])
assert any(item.get('tool') == 'mcp_call' and item.get('success') is True and item['arguments'].get('connectorId') == saved['connectors']['notes']['id'] for item in items)
report = json.loads((root/'headless-result.json').read_text(encoding='utf-8'))
case = {'name': 'Actual closed-window model discovers App IDs through native tools, calls the owned fallback and receives truthful unavailable cloud metadata', 'passed': True}
if not any(item['name'] == case['name'] for item in report['cases']):
    report['cases'].append(case)
(root/'headless-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'actualSuccessfulTools': [item['tool'] for item in items if item.get('success') is True]}))
