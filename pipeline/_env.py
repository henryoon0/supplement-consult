"""Shared helpers: load ax-hub credentials (never printed) and LLM call."""
import os, pathlib
# 내 ax-hub 키는 저장소 밖 .env 에 둔다 (pipeline/.env, git 에 안 올라감)
ENV_PATH = pathlib.Path(os.environ.get("AXHUB_ENV", pathlib.Path(__file__).resolve().parent / ".env"))
ROOT = pathlib.Path(__file__).resolve().parent  # pipeline/ — 중간 데이터는 pipeline/data/

def load_env():
    vals = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals["AXHUB_SUPABASE_URL"].rstrip("/"), vals["AXHUB_SUPABASE_ANON_KEY"]

def headers():
    _, key = load_env()
    return {"apikey": key, "Authorization": f"Bearer {key}"}


# ---------------- LLM (local ChatGPT-subscription proxy) ----------------
import json as _json, time as _time, re as _re, threading as _th
import requests as _rq

LLM_URL = os.environ.get("PIPELINE_LLM_URL", "http://localhost:8787/v1/chat/completions")
LLM_MODEL = os.environ.get("PIPELINE_LLM_MODEL", "gpt-6-luna")
LLM_LOG = ROOT / "data/llm_calls.jsonl"
_log_lock = _th.Lock()


def est_tokens(s):
    """Rough token estimate: ASCII chars/4 plus 1 token per non-ASCII char.
    The proxy does not return usage, so this is an estimate."""
    a = sum(1 for ch in s if ord(ch) < 128)
    return a / 4 + (len(s) - a)


def _extract_json(text):
    text = text.strip()
    m = _re.search(r"```(?:json)?\s*(.*?)```", text, _re.S)
    if m:
        text = m.group(1).strip()
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=0)
    return _json.loads(text[start:])


def llm_json(system, user, tag, validate=None, tries=4):
    """Call the proxy, parse strict JSON, optionally validate; retry on failure.
    Every attempt is logged to data/llm_calls.jsonl (latency, est tokens, status)."""
    last_err = None
    for i in range(tries):
        t0 = _time.time()
        status, out = None, ""
        try:
            r = _rq.post(LLM_URL, json={"model": LLM_MODEL, "messages": [
                {"role": "system", "content": system}, {"role": "user", "content": user}]}, timeout=90)
            status = r.status_code
            if r.status_code == 200:
                out = r.json()["choices"][0]["message"]["content"]
                data = _extract_json(out)
                if validate:
                    validate(data)
                ok = True
            else:
                ok = False
                last_err = f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as e:
            ok = False
            last_err = repr(e)[:300]
        dt = _time.time() - t0
        with _log_lock:
            LLM_LOG.parent.mkdir(parents=True, exist_ok=True)
            with open(LLM_LOG, "a") as f:
                f.write(_json.dumps({"tag": tag, "t": t0, "sec": round(dt, 2), "status": status, "ok": ok,
                                     "in_tok": round(est_tokens(system + user)), "out_tok": round(est_tokens(out)),
                                     "attempt": i, "err": None if ok else last_err}) + "\n")
        if ok:
            return data
        _time.sleep(5 * (i + 1) if status == 429 else 1)
    raise RuntimeError(f"LLM failed after {tries} tries: {last_err}")
