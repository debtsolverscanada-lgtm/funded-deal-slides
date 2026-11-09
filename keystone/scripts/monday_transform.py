import json, sys, os, re
raw = json.load(open(sys.argv[1])); outdir = sys.argv[2]; os.makedirs(outdir, exist_ok=True)
SKIP = {'name', 'subtasks', 'button', 'direct_doc', 'doc'}
RO = {'formula', 'mirror', 'last_updated', 'item_id', 'board_relation', 'time_tracking', 'file', 'location', 'country', 'dropdown', 'link'}
def conv_cols(cols):
    out = []
    for c in cols:
        t = c['type']
        if t in SKIP: continue
        s = {}
        try: s = json.loads(c['settings_str'] or '{}')
        except Exception: pass
        col = {'id': c['id'], 'title': c['title']}
        if t == 'status':
            col['type'] = 'status'; labels = []
            pos = s.get('labels_positions_v2') or {}
            for k, v in (s.get('labels') or {}).items():
                if v is None: continue
                color = ((s.get('labels_colors') or {}).get(k) or {}).get('color') or '#c4c4c4'
                l = {'id': str(k), 'label': v or '(blank)', 'color': color}
                if (s.get('labels_descriptions') or {}).get(k): l['desc'] = s['labels_descriptions'][k]
                if int(k) in (s.get('deactivated_labels') or []): l['hidden'] = True
                l['_p'] = pos.get(k, 999); labels.append(l)
            labels.sort(key=lambda l: l['_p'])
            for l in labels: l.pop('_p')
            col['labels'] = labels
        elif t == 'people': col['type'] = 'person'
        elif t == 'date': col['type'] = 'date'
        elif t == 'phone': col['type'] = 'phone'
        elif t == 'email': col['type'] = 'email'
        elif t == 'numbers':
            col['type'] = 'number'; sym = ((s.get('unit') or {}).get('symbol') or '')
            if sym == '$': col['format'] = 'currency'
            elif sym == '%': col['format'] = 'percent'
        else:
            col['type'] = 'text'
            if t in RO: col['readonly'] = True; col['source'] = t
            if t == 'long_text': col['long'] = True
        out.append(col)
    return out
def conv_vals(cvs, cols):
    ids = {c['id']: c for c in cols}; v = {}
    for cv in cvs:
        c = ids.get(cv['id'])
        if not c: continue
        val = None
        if c['type'] == 'status':
            try: val = str(json.loads(cv['value'])['index']) if cv['value'] else None
            except Exception: val = None
        elif c['type'] == 'date':
            try: val = json.loads(cv['value']).get('date') if cv['value'] else None
            except Exception: val = None
        elif c['type'] == 'number':
            t = (cv['text'] or '').replace(',', '')
            try: val = float(t) if t else None
            except Exception: val = None
            if val is not None and val == int(val): val = int(val)
        else:
            val = cv['text'] or None
        if val not in (None, ''): v[c['id']] = val
    return v
manifest = {'exported_at': raw['exported_at'], 'parts': [], 'boards': []}
folder_of = {}
for f in raw['folders']:
    for ch in f['children'] or []: folder_of[str(ch['id'])] = f['name']
part, part_size, n = [], 0, 1
def flush():
    global part, part_size, n
    if not part: return
    name = f'part{n}.json'; json.dump(part, open(os.path.join(outdir, name), 'w'), separators=(',', ':'))
    manifest['parts'].append(name); part, part_size, n = [], 0, n + 1
total_items = 0
for order, b in enumerate(raw['boards']):
    cols = conv_cols(b['columns']); subcols = conv_cols(b['sub_columns'])
    groups = sorted(b['groups'], key=lambda g: float(g.get('position') or 0))
    bid = 'm' + b['id']
    board = {'id': bid, 'name': b['name'], 'order': order + 1, 'folder': folder_of.get(str(b['id'])) or '', 'source': 'monday', 'mondayId': b['id'],
             'groups': [{'id': g['id'], 'name': g['title'], 'color': g['color'] or '#579bfc'} for g in groups],
             'columns': cols, 'subColumns': subcols, 'automations': []}
    manifest['boards'].append({'id': bid, 'name': b['name'], 'items': len(b['items'])})
    items = []
    for pos, i in enumerate(b['items']):
        ups = [{'at': u['created_at'], 'by': '', 'byName': (u['creator'] or {}).get('name') or 'Monday user', 'text': (u['text_body'] or '')[:4000]} for u in reversed(i['updates'] or [])]
        subs = [{'id': s['id'], 'name': s['name'], 'values': conv_vals(s['column_values'], subcols)} for s in (i['subitems'] or [])]
        doc = {'id': i['id'], 'name': i['name'], 'group': (i['group'] or {}).get('id'), 'pos': pos, 'values': conv_vals(i['column_values'], cols),
               'updates': ups, 'subitems': subs, 'mondayId': i['id'], 'createdAt': i['created_at'],
               'activity': [{'at': raw['exported_at'], 'by': 'import', 'text': 'Copied from Monday'}]}
        s = len(json.dumps(doc))
        while s > 240000 and doc['updates']: doc['updates'].pop(0); s = len(json.dumps(doc))
        items.append(doc)
    total_items += len(items)
    # split a board's items across parts if needed
    chunk = []
    entry = {'board': board, 'items': chunk}; part.append(entry); part_size += len(json.dumps(board))
    for it in items:
        sz = len(json.dumps(it))
        if part_size + sz > 14_000_000:
            flush(); chunk = []; part.append({'board': board, 'items': chunk}); part_size = len(json.dumps(board))
        chunk.append(it); part_size += sz
flush()
manifest['total_items'] = total_items
json.dump(manifest, open(os.path.join(outdir, 'manifest.json'), 'w'), indent=1)
print(total_items, 'items', manifest['parts'])
