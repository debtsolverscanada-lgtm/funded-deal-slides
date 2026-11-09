import json, os, sys, time, urllib.request, ssl
OUT = sys.argv[1]
ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)
TOKEN = os.environ.get("MONDAY_API_TOKEN") or sys.exit("Set MONDAY_API_TOKEN to a Monday API token (Admin > Developers > API).")
WS = int(os.environ.get("MONDAY_WORKSPACE_ID", "11508737"))
def gql(q, variables=None, tries=6):
    body = json.dumps({"query": q, "variables": variables or {}}).encode()
    for t in range(tries):
        req = urllib.request.Request("https://api.monday.com/v2", data=body, headers={"Content-Type": "application/json", "Authorization": TOKEN, "API-Version": "2025-04"})
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=120) as r:
                d = json.load(r)
        except Exception as e:
            print("retry", e, file=sys.stderr); time.sleep(2 ** t); continue
        if d.get("errors") or d.get("error_message"):
            msg = json.dumps(d)[:400]
            if "omplexity" in msg or "rate" in msg.lower() or "429" in msg:
                print("throttled, waiting", msg[:200], file=sys.stderr); time.sleep(20); continue
            raise SystemExit("API error: " + msg)
        return d["data"]
    raise SystemExit("gave up")


boards = gql("""{ boards(workspace_ids:[%d], limit:200){ id name type board_kind board_folder_id items_count
  groups{ id title color position } columns{ id title type settings_str } } }""" % WS)["boards"]
folders = gql("""{ folders(workspace_ids:[%d]){ id name children{ id } } }""" % WS)["folders"]
sub_by_name = {b["name"]: b for b in boards if b["type"] == "sub_items_board"}
ITEM_FIELDS = """id name state group{ id } created_at
  column_values{ id type text value }
  updates(limit:25){ id text_body created_at creator{ name } }
  subitems{ id name column_values{ id type text value } }"""
out = {"exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "folders": folders, "boards": []}
for b in boards:
    if b["type"] != "board": continue
    items = []
    if b["items_count"]:
        d = gql("""query($id:[ID!]){ boards(ids:$id){ items_page(limit:100){ cursor items{ %s } } } }""" % ITEM_FIELDS, {"id": [b["id"]]})
        page = d["boards"][0]["items_page"]; items += page["items"]; cur = page["cursor"]
        while cur:
            d = gql("""query($c:String!){ next_items_page(limit:100, cursor:$c){ cursor items{ %s } } }""" % ITEM_FIELDS, {"c": cur})
            page = d["next_items_page"]; items += page["items"]; cur = page["cursor"]
    sb = sub_by_name.get("Subitems of " + b["name"])
    b["sub_columns"] = sb["columns"] if sb else []
    b["items"] = items
    out["boards"].append(b)
    print(f"{b['name']}: {len(items)} items", file=sys.stderr)
json.dump(out, open(OUT, "w"))
print("wrote", OUT, os.path.getsize(OUT), "bytes")
