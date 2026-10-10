#!/usr/bin/env python3
"""Evaluate an OpenAI-compatible model server that is already running.

Subcommands: probe, speed, run, tables, chart, selftest. Standard library only.
"""

import argparse
import hashlib
import json
import os
import platform
import random
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_PACK = HERE / "packs" / "general-v1.json"
OTHER_VENDORS = {
    "openai": ["openai", "chatgpt", "gpt-4", "gpt-5"],
    "anthropic": ["anthropic", "claude"],
    "google": ["google", "gemini", "gemma"],
    "deepseek": ["deepseek"],
    "alibaba": ["qwen", "alibaba", "通义", "阿里"],
    "meta": ["meta ai", "llama"],
    "mistral": ["mistral"],
    "moonshot": ["moonshot", "kimi"],
    "zhipu": ["zhipu", "chatglm", "智谱"],
    "minimax": ["minimax"],
    "modelbest": ["minicpm", "openbmb", "modelbest", "面壁"],
}


# ---------- HTTP ----------

def normalize_base(url):
    url = url.strip().rstrip("/")
    if not re.match(r"^https?://", url):
        url = "http://" + url
    if not re.search(r"/v\d+$", url):
        url += "/v1"
    return url


def server_root(base):
    return re.sub(r"/v\d+$", "", base)


def http_json(url, payload=None, timeout=10, method=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + os.environ.get("HOLAEVAL_API_KEY", "local"))
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def try_json(url, payload=None, timeout=3, method=None):
    try:
        return http_json(url, payload, timeout=timeout, method=method)
    except Exception:
        return None


def chat(base, payload, timeout=1800):
    return http_json(base + "/chat/completions", payload, timeout=timeout)


def stream_chat(base, payload, timeout=900):
    """Return (ttft_s, total_s, n_chunks, final_usage, final_timings, text)."""
    payload = dict(payload, stream=True, stream_options={"include_usage": True})
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + os.environ.get("HOLAEVAL_API_KEY", "local"))
    started = time.perf_counter()
    first = None
    last = None
    chunks = 0
    usage = None
    timings = None
    parts = []
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                break
            try:
                evt = json.loads(body)
            except json.JSONDecodeError:
                continue
            if evt.get("usage"):
                usage = evt["usage"]
            if evt.get("timings"):
                timings = evt["timings"]
            for choice in evt.get("choices") or []:
                delta = choice.get("delta") or {}
                piece = (delta.get("content") or "") + (delta.get("reasoning_content") or delta.get("reasoning") or "")
                if piece:
                    now = time.perf_counter()
                    if first is None:
                        first = now
                    last = now
                    chunks += 1
                    parts.append(piece)
    end = last or time.perf_counter()
    return (first - started if first else None), end - started, chunks, usage, timings, "".join(parts), (end - first if first else None)


# ---------- probe ----------

def detect(base):
    root = server_root(base)
    info = {"base_url": base, "engine": "openai_compatible", "engine_version": None, "models": []}
    props = try_json(root + "/props")
    ollama_ver = try_json(root + "/api/version")
    lms = try_json(root + "/api/v0/models")
    vllm_ver = try_json(root + "/version")
    sglang = try_json(root + "/get_model_info")
    models = try_json(base + "/models") or {}
    ids = [m.get("id") for m in models.get("data", []) if isinstance(m, dict) and m.get("id")]
    if isinstance(ollama_ver, dict) and "version" in ollama_ver:
        info["engine"], info["engine_version"] = "ollama", ollama_ver["version"]
        tags = try_json(root + "/api/tags") or {}
        for m in tags.get("models", []):
            entry = {"id": m.get("name"), "digest": m.get("digest"), "size_bytes": m.get("size"),
                     "quantization": (m.get("details") or {}).get("quantization_level")}
            show = try_json(root + "/api/show", {"model": m.get("name")}, timeout=5) or {}
            for k, v in (show.get("model_info") or {}).items():
                if k.endswith(".context_length"):
                    entry["context_window"] = v
            entry["supports_vision"] = "vision" in (show.get("capabilities") or [])
            info["models"].append(entry)
        running = try_json(root + "/api/ps") or {}
        info["loaded"] = [{"id": m.get("name"), "context_length": m.get("context_length")} for m in running.get("models", [])]
    elif isinstance(props, dict) and ("default_generation_settings" in props or "n_ctx" in props or "build_info" in props):
        info["engine"] = "llamacpp"
        info["engine_version"] = props.get("build_info")
        gen = props.get("default_generation_settings") or {}
        n_ctx = gen.get("n_ctx") or props.get("n_ctx")
        info["server_props"] = {k: props.get(k) for k in ("model_path", "total_slots", "chat_template_caps") if k in props}
        info["server_defaults"] = {k: (gen.get("params") or gen).get(k) for k in ("temperature", "top_p", "top_k", "min_p", "n_predict") if k in (gen.get("params") or gen)}
        for mid in ids or [Path(props.get("model_path", "model")).name]:
            info["models"].append({"id": mid, "context_window": n_ctx})
    elif isinstance(lms, dict) and isinstance(lms.get("data"), list):
        info["engine"] = "lmstudio"
        for m in lms["data"]:
            if m.get("type") == "embeddings":
                continue
            info["models"].append({"id": m.get("id"), "context_window": m.get("loaded_context_length") or m.get("max_context_length"),
                                   "loaded": m.get("state") == "loaded", "supports_vision": m.get("type") == "vlm",
                                   "quantization": m.get("quantization")})
    elif isinstance(sglang, dict) and sglang.get("model_path"):
        info["engine"] = "sglang"
        for mid in ids:
            info["models"].append({"id": mid})
    elif isinstance(vllm_ver, dict) and vllm_ver.get("version"):
        info["engine"], info["engine_version"] = "vllm", vllm_ver["version"]
        for m in models.get("data", []):
            info["models"].append({"id": m.get("id"), "context_window": m.get("max_model_len")})
    else:
        for mid in ids:
            info["models"].append({"id": mid})
    return info


def machine_info():
    info = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version()}
    if sys.platform == "darwin":
        def sysctl(key):
            try:
                return subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, timeout=5).stdout.strip()
            except Exception:
                return None
        info["cpu"] = sysctl("machdep.cpu.brand_string")
        info["model"] = sysctl("hw.model")
        mem = sysctl("hw.memsize")
        info["memory_gb"] = round(int(mem) / 2**30) if mem and mem.isdigit() else None
        try:
            batt = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=5).stdout
            info["power"] = "AC" if "AC Power" in batt else ("battery" if "Battery Power" in batt else None)
        except Exception:
            pass
    elif sys.platform.startswith("linux"):
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal"):
                    info["memory_gb"] = round(int(line.split()[1]) / 2**20)
            cpu = [l for l in Path("/proc/cpuinfo").read_text().splitlines() if l.startswith("model name")]
            info["cpu"] = cpu[0].split(":", 1)[1].strip() if cpu else None
        except Exception:
            pass
        if shutil.which("nvidia-smi"):
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True)
            info["gpus"] = [g.strip() for g in out.stdout.splitlines() if g.strip()]
    return info


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            h.update(block)
    return h.hexdigest()


def cmd_probe(args):
    base = normalize_base(args.base_url)
    info = detect(base)
    if args.model:
        found = [m for m in info["models"] if m["id"] == args.model]
        if not found and info["models"]:
            info["warning"] = f"model {args.model!r} not listed by server; listed: {[m['id'] for m in info['models']]}"
        model = args.model
    else:
        model = info["models"][0]["id"] if info["models"] else None
    info["selected_model"] = model
    if model:
        try:
            t0 = time.perf_counter()
            resp = chat(base, {"model": model, "messages": [{"role": "user", "content": "Reply with OK."}], "max_tokens": 512, "temperature": 0}, timeout=180)
            info["smoke"] = {"ok": True, "seconds": round(time.perf_counter() - t0, 2),
                             "returns_reasoning": bool((resp["choices"][0]["message"].get("reasoning_content"))),
                             "finish_reason": resp["choices"][0].get("finish_reason")}
        except Exception as exc:
            info["smoke"] = {"ok": False, "error": repr(exc)}
    model_path = (info.get("server_props") or {}).get("model_path")
    if args.hash_model_file and model_path and Path(model_path).is_file():
        info["model_file_sha256"] = sha256_file(model_path)
    info["machine"] = machine_info()
    info["probed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "manifest.json").write_text(json.dumps(info, indent=2, ensure_ascii=False))
    print(json.dumps(info, indent=2, ensure_ascii=False))


# ---------- graders ----------

def boxed_int(text):
    hits = re.findall(r"\\boxed\{\s*([-\d,\.]+)\s*\}", text)
    if not hits:
        return None
    try:
        return int(float(hits[-1].replace(",", "")))
    except ValueError:
        return None


def code_block(text):
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text, re.S)
    return blocks[-1] if blocks else text


def run_python_tests(code, tests, timeout=10):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "solution.py"
        path.write_text(code + "\n\n" + tests + "\nprint('ALL_PASS')\n")
        try:
            out = subprocess.run([sys.executable, "-I", str(path)], cwd=d, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return False, "tests timed out"
        if out.returncode == 0 and "ALL_PASS" in out.stdout:
            return True, None
        err = (out.stderr.strip().splitlines() or ["no output"])[-1]
        return False, f"tests failed: {err[:160]}"


def check_rules(text, rules):
    t = text.strip()
    lines = [l for l in t.splitlines() if l.strip()]
    for rule in rules:
        if "lines_exact" in rule and len(lines) != rule["lines_exact"]:
            return False, f"expected {rule['lines_exact']} lines, got {len(lines)}"
        if "each_line_startswith" in rule and not all(l.startswith(rule["each_line_startswith"]) for l in lines):
            return False, f"a line does not start with {rule['each_line_startswith']!r}"
        if "max_words" in rule and len(t.split()) >= rule["max_words"]:
            return False, f"{len(t.split())} words, limit < {rule['max_words']}"
        if "max_chars" in rule and len(t) > rule["max_chars"]:
            return False, f"{len(t)} chars, limit {rule['max_chars']}"
        if "must_include" in rule and rule["must_include"].lower() not in t.lower():
            return False, f"missing {rule['must_include']!r}"
        if "ends_with" in rule and not t.endswith(rule["ends_with"]):
            return False, f"does not end with {rule['ends_with']!r}"
        if rule.get("no_latin") and re.search(r"[A-Za-z]", t):
            return False, "contains latin letters"
        if rule.get("single_line") and "\n" in t:
            return False, "more than one line"
    return True, None


def check_json(text, spec):
    raw = text.strip()
    if spec.get("no_fence") and raw.startswith("```"):
        return False, "wrapped in a code fence"
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return False, "not valid JSON"
    if not isinstance(obj, dict):
        return False, "not a JSON object"
    if "keys_exact" in spec and set(obj) != set(spec["keys_exact"]):
        return False, f"keys {sorted(obj)} != {sorted(spec['keys_exact'])}"
    for key, n in (spec.get("array_len") or {}).items():
        if not isinstance(obj.get(key), list) or len(obj[key]) != n:
            return False, f"{key} must be an array of {n}"
    for key in spec.get("lowercase_array") or []:
        if not all(isinstance(v, str) and v == v.lower() for v in obj.get(key) or []):
            return False, f"{key} must be lowercase strings"
    return True, None


def first_tool_call(resp):
    calls = resp.get("tool_calls") or []
    if not calls:
        return None, None
    fn = calls[0].get("function") or {}
    args = fn.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {"_raw": args}
    return fn.get("name"), args or {}


def check_tool_call(resp, spec):
    name, args = first_tool_call(resp)
    if name is None:
        return False, "no tool call"
    if name != spec["name"]:
        return False, f"called {name} instead of {spec['name']}"
    for key, cond in (spec.get("args") or {}).items():
        value = args.get(key)
        sval = "" if value is None else str(value)
        if "equals" in cond and value != cond["equals"]:
            return False, f"{key}={value!r}, expected {cond['equals']!r}"
        if "equals_ci" in cond and sval.lower() != str(cond["equals_ci"]).lower():
            return False, f"{key}={value!r}, expected {cond['equals_ci']!r}"
        if "contains_ci" in cond and str(cond["contains_ci"]).lower() not in sval.lower():
            return False, f"{key}={value!r} should contain {cond['contains_ci']!r}"
        if "one_of_ci" in cond and sval.lower() not in [c.lower() for c in cond["one_of_ci"]]:
            return False, f"{key}={value!r} not in {cond['one_of_ci']}"
    return True, None


def identity_lists(own):
    own_l = [k.lower() for k in own]
    others = []
    for keywords in OTHER_VENDORS.values():
        if any(k in own_l or any(k in o or o in k for o in own_l) for k in keywords):
            continue
        others.extend(keywords)
    return own_l, others


def check_identity(text, own):
    own_l, others = identity_lists(own)
    t = text.lower()
    claimed = [k for k in others if k in t]
    if claimed:
        return False, f"claims another vendor: {claimed[0]}"
    if not any(k in t for k in own_l):
        return False, "does not name its own model/vendor"
    return True, None


def grade(task, resp, ctx):
    g = task["grader"]
    kind = g["type"]
    text = resp.get("content") or ""
    if resp.get("finish_reason") == "length" and kind not in ("tool_call", "no_tool_call") and not text.strip():
        return False, "ran out of tokens before answering"
    if kind == "boxed_int":
        got = boxed_int(text)
        return (got == g["answer"], None if got == g["answer"] else ("no \\boxed{} answer" if got is None else f"answered {got}, expected {g['answer']}"))
    if kind == "python_tests":
        return run_python_tests(code_block(text), g["tests"])
    if kind == "rules":
        return check_rules(text, g["rules"])
    if kind == "json_object":
        return check_json(text, g)
    if kind == "tool_call":
        return check_tool_call(resp, g)
    if kind == "no_tool_call":
        if resp.get("tool_calls"):
            return False, "called a tool when none was needed"
        ok = g.get("content_contains", "") in text
        return ok, None if ok else f"answer missing {g.get('content_contains')!r}"
    if kind == "contains":
        ok = g["value"] in text
        if ok:
            return True, None
        if resp.get("prompt_truncated"):
            return False, "prompt was truncated by the server context window"
        return False, f"answer missing {g['value']!r}"
    if kind == "identity":
        return check_identity(text, ctx["identity"])
    raise ValueError(f"unknown grader {kind}")


# ---------- tasks ----------

FILLER = [
    "The archive committee met on a Tuesday to review the shelving plan for the east wing.",
    "Several volunteers noted that the reading room lamps flicker when the heating turns on.",
    "A delivery of oak boards arrived late because the truck took the river road.",
    "The catalogue lists maps, letters, and ledgers from three neighbouring towns.",
    "Visitors are asked to sign the guest book and leave umbrellas by the door.",
    "An old clock in the hallway runs four minutes fast and nobody has fixed it.",
    "The gardener planted lavender along the path that leads to the side entrance.",
    "Most requests for photocopies are handled within two working days.",
]


def filler_text(approx_tokens, seed):
    rng = random.Random(seed)
    sentences = []
    while len(" ".join(sentences)) / 4.2 < approx_tokens:
        sentences.append(rng.choice(FILLER))
    return sentences


def build_messages(task):
    messages = []
    if task.get("system"):
        messages.append({"role": "system", "content": task["system"]})
    prompt = task["prompt"]
    hay = task.get("haystack")
    if hay:
        sentences = filler_text(hay["approx_tokens"], hay.get("seed", hay["approx_tokens"]))
        sentences.insert(int(len(sentences) * hay.get("depth", 0.5)), hay["needle"])
        prompt = " ".join(sentences) + "\n\n" + prompt
    messages.append({"role": "user", "content": prompt})
    return messages


def load_pack(path):
    pack = json.loads(Path(path).read_text())
    for t in pack["tasks"]:
        t.setdefault("category", "general")
    return pack


def run_one(base, model, task, sample, sampling, ctx):
    payload = {"model": model, "messages": build_messages(task), "max_tokens": task.get("max_tokens", 6000), **sampling}
    if task.get("tools"):
        payload["tools"] = task["tools"]
    if ctx["engine"] == "llamacpp":
        payload["cache_prompt"] = False
    started = time.time()
    rec = {"id": task["id"], "category": task["category"], "sample": sample}
    try:
        data = chat(base, payload)
        choice = data["choices"][0]
        msg = choice.get("message") or {}
        usage = data.get("usage") or {}
        resp = {
            "content": msg.get("content") or "",
            "reasoning": msg.get("reasoning_content") or msg.get("reasoning") or "",
            "tool_calls": msg.get("tool_calls"),
            "finish_reason": choice.get("finish_reason"),
            "usage": usage,
            "timings": data.get("timings"),
        }
        hay = task.get("haystack")
        if hay and usage.get("prompt_tokens") and usage["prompt_tokens"] < 0.7 * hay["approx_tokens"]:
            resp["prompt_truncated"] = True
        passed, reason = grade(task, resp, ctx)
        rec.update(resp, passed=bool(passed), reason=reason, error=None)
    except Exception as exc:
        rec.update(passed=False, reason="request failed", error=repr(exc))
    rec["seconds"] = round(time.time() - started, 1)
    return rec


def cmd_run(args):
    base = normalize_base(args.base_url)
    pack = load_pack(args.pack)
    info = detect(base)
    model = args.model or (info["models"][0]["id"] if info["models"] else None)
    if not model:
        sys.exit("no model: pass --model")
    ctx_window = args.context_window or next((m.get("context_window") for m in info["models"] if m["id"] == model and m.get("context_window")), None)
    identity = [s.strip() for s in (args.identity or "").split(",") if s.strip()]
    sampling = dict(pack.get("sampling") or {})
    for key in ("temperature", "top_p", "min_p"):
        if getattr(args, key) is not None:
            sampling[key] = getattr(args, key)
    samples = args.samples or pack.get("samples", 3)
    only = [s for s in (args.only or "").split(",") if s]
    tasks, skipped = [], []
    for t in pack["tasks"]:
        if only and not any(t["id"].startswith(o) or t["category"] == o for o in only):
            continue
        if t["grader"]["type"] == "identity" and not identity:
            skipped.append({"id": t["id"], "reason": "no --identity keywords given"})
            continue
        hay = t.get("haystack")
        if hay and ctx_window and hay["approx_tokens"] * 1.15 > ctx_window:
            skipped.append({"id": t["id"], "reason": f"needs ~{hay['approx_tokens']} tokens, context window is {ctx_window}"})
            continue
        if args.quick and hay and hay["approx_tokens"] > 10000:
            skipped.append({"id": t["id"], "reason": "skipped in --quick"})
            continue
        tasks.append(t)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    label = args.label
    ctx = {"engine": info["engine"], "identity": identity}
    jobs = [(t, s) for t in tasks for s in range(samples)]
    progress = open(out / f"progress-{label}.log", "a", buffering=1)
    say = lambda msg: (print(msg, flush=True), progress.write(msg + "\n"))
    say(f"START {label} model={model} engine={info['engine']} tasks={len(tasks)} samples={samples} jobs={len(jobs)} skipped={len(skipped)}")
    results = []
    started = time.time()
    lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=args.parallel) as pool, open(out / f"tasks-{label}.jsonl", "w") as f:
        futures = [pool.submit(run_one, base, model, t, s, sampling, ctx) for t, s in jobs]
        for i, fut in enumerate(futures, 1):
            rec = fut.result()
            with lock:
                results.append(rec)
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                f.flush()
            say(f"[{i}/{len(jobs)}] {rec['id']}#{rec['sample']} {'PASS' if rec['passed'] else 'FAIL'} {rec['seconds']}s"
                + (f" ({rec['reason']})" if not rec["passed"] else ""))
    summary = {"label": label, "model": model, "base_url": base, "engine": info["engine"], "pack": pack.get("id"),
               "pack_version": pack.get("version"), "sampling": sampling, "samples": samples, "identity": identity,
               "context_window": ctx_window, "skipped": skipped, "wall_seconds": round(time.time() - started, 1),
               "by_task": {}, "by_category": {}}
    for rec in results:
        t = summary["by_task"].setdefault(rec["id"], {"category": rec["category"], "passed": 0, "n": 0, "reasons": {}, "completion_tokens": []})
        t["passed"] += rec["passed"]
        t["n"] += 1
        if not rec["passed"]:
            t["reasons"][rec["reason"] or "failed"] = t["reasons"].get(rec["reason"] or "failed", 0) + 1
        ct = (rec.get("usage") or {}).get("completion_tokens")
        if ct:
            t["completion_tokens"].append(ct)
        c = summary["by_category"].setdefault(rec["category"], {"passed": 0, "n": 0})
        c["passed"] += rec["passed"]
        c["n"] += 1
    (out / f"summary-{label}.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    say(f"DONE {label} " + " ".join(f"{k}={v['passed']}/{v['n']}" for k, v in summary["by_category"].items())
        + f" wall={summary['wall_seconds']}s")


# ---------- speed ----------

COUNT_PROMPT = "Count from one to two thousand in English words, separated by commas. Do not stop early and do not explain."


def cmd_speed(args):
    base = normalize_base(args.base_url)
    info = detect(base)
    model = args.model or (info["models"][0]["id"] if info["models"] else None)
    ctx_window = args.context_window or next((m.get("context_window") for m in info["models"] if m["id"] == model and m.get("context_window")), None)
    depths = [int(d) for d in args.depths.split(",")]
    rows = []
    for depth in depths:
        if ctx_window and depth + args.gen + 256 > ctx_window:
            rows.append({"depth": depth, "skipped": f"context window {ctx_window} too small"})
            print(json.dumps(rows[-1]), flush=True)
            continue
        runs = []
        for rep in range(args.reps + 1):
            prefix = " ".join(filler_text(depth, seed=depth * 31 + rep + int(time.time()))) + "\n\n" if depth else ""
            payload = {"model": model, "messages": [{"role": "user", "content": prefix + COUNT_PROMPT}],
                       "max_tokens": args.gen, "temperature": 0}
            if info["engine"] == "llamacpp":
                payload["cache_prompt"] = False
            ttft, total, chunks, usage, timings, _, gen_s = stream_chat(base, payload)
            if rep == 0 and args.reps > 0:
                continue
            completion = (usage or {}).get("completion_tokens") or chunks
            prompt_tokens = (usage or {}).get("prompt_tokens")
            run = {"ttft_s": round(ttft, 3) if ttft else None, "completion_tokens": completion, "prompt_tokens": prompt_tokens,
                   "decode_tps": round((completion - 1) / gen_s, 1) if gen_s and completion > 1 else None,
                   "prefill_tps": round(prompt_tokens / ttft, 1) if prompt_tokens and ttft else None}
            if timings:
                run["engine_decode_tps"] = round(timings.get("predicted_per_second") or 0, 1) or None
                run["engine_prefill_tps"] = round(timings.get("prompt_per_second") or 0, 1) or None
            runs.append(run)
        row = {"depth": depth, "runs": runs}
        for key in ("ttft_s", "decode_tps", "prefill_tps", "engine_decode_tps", "engine_prefill_tps"):
            vals = [r[key] for r in runs if r.get(key)]
            if vals:
                row[key] = round(statistics.mean(vals), 3 if key == "ttft_s" else 1)
                row[key + "_sd"] = round(statistics.pstdev(vals), 3 if key == "ttft_s" else 1)
        rows.append(row)
        print(json.dumps({k: v for k, v in row.items() if k != "runs"}), flush=True)
    conc = []
    for n in [int(x) for x in (args.concurrency or "").split(",") if x]:
        payload = {"model": model, "messages": [{"role": "user", "content": COUNT_PROMPT}], "max_tokens": args.gen, "temperature": 0}
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=n) as pool:
            outs = list(pool.map(lambda _: stream_chat(base, payload), range(n)))
        wall = time.perf_counter() - t0
        total_tokens = sum(((o[3] or {}).get("completion_tokens") or o[2]) for o in outs)
        conc.append({"concurrency": n, "aggregate_tps": round(total_tokens / wall, 1), "wall_s": round(wall, 2)})
        print(json.dumps(conc[-1]), flush=True)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"speed-{args.label}.json").write_text(json.dumps(
        {"label": args.label, "model": model, "engine": info["engine"], "base_url": base, "gen_tokens": args.gen,
         "reps": args.reps, "context_window": ctx_window, "depths": rows, "concurrency": conc}, indent=2))


# ---------- tables ----------

def cmd_tables(args):
    d = Path(args.dir)
    out = []
    speeds = sorted(d.glob("speed-*.json"))
    if speeds:
        out += ["### Speed (streaming over HTTP, temperature 0)", "",
                "| Run | Context depth | Time to first token | Prefill tok/s | Decode tok/s |", "|---|---|---|---|---|"]
        for p in speeds:
            s = json.loads(p.read_text())
            for row in s["depths"]:
                if row.get("skipped"):
                    out.append(f"| {s['label']} | {row['depth']} | skipped: {row['skipped']} | | |")
                    continue
                dec = row.get("engine_decode_tps") or row.get("decode_tps")
                pre = row.get("engine_prefill_tps") or row.get("prefill_tps")
                out.append(f"| {s['label']} | {row['depth']} | {row.get('ttft_s', '-')} s | {pre or '-'} | {dec or '-'} |")
            for c in s.get("concurrency") or []:
                out.append(f"| {s['label']} | {c['concurrency']} parallel requests | | | {c['aggregate_tps']} (aggregate) |")
        out.append("")
    summaries = {json.loads(p.read_text())["label"]: json.loads(p.read_text()) for p in sorted(d.glob("summary-*.json"))}
    if summaries:
        labels = list(summaries)
        out += ["### Capability spot check (passed / samples)", "", "| Category | " + " | ".join(labels) + " |", "|---|" + "---|" * len(labels)]
        cats = []
        for s in summaries.values():
            cats += [c for c in s["by_category"] if c not in cats]
        for c in cats:
            out.append(f"| {c} | " + " | ".join(
                f"{s['by_category'][c]['passed']}/{s['by_category'][c]['n']}" if c in s["by_category"] else "-" for s in summaries.values()) + " |")
        out += ["", "### Per task", "", "| Task | Category | " + " | ".join(labels) + " | Failure reasons |", "|---|---|" + "---|" * len(labels) + "---|"]
        tids = []
        for s in summaries.values():
            tids += [t for t in s["by_task"] if t not in tids]
        for tid in tids:
            cat = next(s["by_task"][tid]["category"] for s in summaries.values() if tid in s["by_task"])
            reasons = []
            for lab, s in summaries.items():
                for r, n in (s["by_task"].get(tid, {}).get("reasons") or {}).items():
                    reasons.append(f"{lab}: {r} ×{n}")
            out.append(f"| {tid} | {cat} | " + " | ".join(
                f"{s['by_task'][tid]['passed']}/{s['by_task'][tid]['n']}" if tid in s["by_task"] else "-" for s in summaries.values())
                + " | " + ("; ".join(reasons) or "") + " |")
        lens = {lab: [n for t in s["by_task"].values() for n in t.get("completion_tokens", [])] for lab, s in summaries.items()}
        if any(lens.values()):
            out += ["", "| Answer length (tokens) | " + " | ".join(labels) + " |", "|---|" + "---|" * len(labels),
                    "| median | " + " | ".join(str(int(statistics.median(v))) if v else "-" for v in lens.values()) + " |",
                    "| max | " + " | ".join(str(max(v)) if v else "-" for v in lens.values()) + " |"]
        skipped = {lab: s["skipped"] for lab, s in summaries.items() if s.get("skipped")}
        if skipped:
            out += ["", "Skipped: " + "; ".join(f"{lab}: {x['id']} ({x['reason']})" for lab, xs in skipped.items() for x in xs)]
    text = "\n".join(out) + "\n"
    (d / "tables.md").write_text(text)
    print(text)


# ---------- chart ----------

SURFACE, INK, INK2, MUTED, GRID, BAR = "#fcfcfb", "#0b0b0b", "#52514e", "#8a8984", "#e6e5e0", "#2a78d6"


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def nice_ticks(vmax, count=4):
    raw = vmax / count
    mag = 10 ** len(str(int(raw))) / 10 if raw >= 1 else 1
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    return [step * i for i in range(int(-(-vmax // step)) + 1)]


def bar_svg(title, subtitle, rows, unit, footnote, vmax=None):
    row_h, top, left, right, w = 64, 150, 300, 1080, 1200
    plot_bottom = top + row_h * len(rows)
    h = plot_bottom + 120
    ticks = nice_ticks(vmax or max(v for _, v in rows) * 1.08)
    vmax = ticks[-1]
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w * 2}" height="{h * 2}" viewBox="0 0 {w} {h}" font-family="Helvetica, Arial, PingFang SC, sans-serif">',
             f'<rect width="{w}" height="{h}" fill="{SURFACE}"/>',
             f'<text x="40" y="58" font-size="30" font-weight="700" fill="{INK}">{esc(title)}</text>',
             f'<text x="40" y="96" font-size="18" fill="{INK2}">{esc(subtitle)}</text>']
    for tick in ticks:
        x = left + (right - left) * tick / vmax
        parts.append(f'<line x1="{x:.1f}" y1="{top - 10}" x2="{x:.1f}" y2="{plot_bottom}" stroke="{GRID}" stroke-width="1"/>')
        parts.append(f'<text x="{x:.1f}" y="{plot_bottom + 24}" font-size="14" fill="{MUTED}" text-anchor="middle">{tick:g}</text>')
    for i, (label, value) in enumerate(rows):
        y = top + row_h * i
        bw = (right - left) * value / vmax
        parts.append(f'<text x="{left - 16}" y="{y + 30}" font-size="19" fill="{INK}" text-anchor="end">{esc(label)}</text>')
        parts.append(f'<rect x="{left}" y="{y + 6}" width="{bw:.1f}" height="36" rx="4" fill="{BAR}"/>')
        parts.append(f'<text x="{left + bw + 10:.1f}" y="{y + 31}" font-size="20" font-weight="700" fill="{INK}">{value:g}</text>')
    parts.append(f'<text x="{(left + right) / 2}" y="{plot_bottom + 54}" font-size="15" fill="{INK2}" text-anchor="middle">{esc(unit)}</text>')
    parts.append(f'<text x="40" y="{h - 20}" font-size="13" fill="{MUTED}">{esc(footnote)}</text>')
    parts.append("</svg>")
    return "\n".join(parts)


def svg_to_png(svg_path, png_path):
    if sys.platform == "darwin" and shutil.which("sips"):
        r = subprocess.run(["sips", "-s", "format", "png", str(svg_path), "--out", str(png_path)], capture_output=True)
        if r.returncode == 0 and Path(png_path).exists():
            return "sips"
    if shutil.which("rsvg-convert"):
        r = subprocess.run(["rsvg-convert", "-o", str(png_path), str(svg_path)], capture_output=True)
        if r.returncode == 0:
            return "rsvg-convert"
    try:
        import cairosvg  # type: ignore

        cairosvg.svg2png(url=str(svg_path), write_to=str(png_path))
        return "cairosvg"
    except Exception:
        return None


def cmd_chart(args):
    d = Path(args.dir)
    rows = []
    if args.kind == "speed":
        for p in sorted(d.glob("speed-*.json")):
            s = json.loads(p.read_text())
            for row in s["depths"]:
                v = row.get("engine_decode_tps") or row.get("decode_tps")
                if v:
                    rows.append((f"{s['label']} · {row['depth'] // 1024}K ctx" if row["depth"] else f"{s['label']} · empty ctx", v))
        unit, default_sub = "decode speed, tokens / second (higher is faster)", "Decode speed by context depth"
    else:
        for p in sorted(d.glob("summary-*.json")):
            s = json.loads(p.read_text())
            for c, v in s["by_category"].items():
                rows.append((f"{s['label']} · {c}", round(100 * v["passed"] / v["n"]) if v["n"] else 0))
        unit, default_sub = "pass rate, % of samples", "Capability spot check"
    if not rows:
        sys.exit("no data for chart")
    manifest = d / "manifest.json"
    foot = args.footnote
    if not foot and manifest.exists():
        m = json.loads(manifest.read_text())
        mach = m.get("machine") or {}
        foot = f"{m.get('engine')} {m.get('engine_version') or ''} · {mach.get('cpu') or mach.get('machine')} · {mach.get('memory_gb') or '?'} GB · {time.strftime('%Y-%m-%d')}"
    svg = bar_svg(args.title, args.subtitle or default_sub, rows, unit, foot or "", vmax=100 if args.kind == "capability" else None)
    svg_path = d / f"{args.kind}.svg"
    svg_path.write_text(svg)
    converter = svg_to_png(svg_path, d / f"{args.kind}.png")
    print(json.dumps({"svg": str(svg_path), "png": str(d / f'{args.kind}.png') if converter else None, "converter": converter}))


# ---------- selftest ----------

def cmd_selftest(_args):
    assert boxed_int("so \\boxed{1,170}") == 1170
    assert boxed_int("no answer") is None
    assert run_python_tests("def f(x):\n    return x+1", "assert f(1)==2")[0]
    assert not run_python_tests("def f(x):\n    return x", "assert f(1)==2")[0]
    assert check_rules("- a\n- b\n- c", [{"lines_exact": 3}, {"each_line_startswith": "- "}])[0]
    assert not check_rules("Intro\n- a\n- b", [{"lines_exact": 3}, {"each_line_startswith": "- "}])[0]
    assert check_rules("可以离线运行的助手", [{"max_chars": 30}, {"must_include": "离线"}, {"no_latin": True}])[0]
    assert check_json('{"title":"x","tags":["a","b","c","d"]}', {"keys_exact": ["title", "tags"], "array_len": {"tags": 4}, "lowercase_array": ["tags"], "no_fence": True})[0]
    assert not check_json('```json\n{}\n```', {"no_fence": True})[0]
    call = {"tool_calls": [{"function": {"name": "search_flights", "arguments": '{"origin":"SFO","destination":"Tokyo","date":"2026-11-03"}'}}]}
    ok, reason = check_tool_call(call, {"name": "search_flights", "args": {"destination": {"one_of_ci": ["TYO", "NRT", "HND"]}}})
    assert not ok and "Tokyo" in reason
    assert check_identity("I am MiniCPM, developed by ModelBest.", ["MiniCPM", "ModelBest", "OpenBMB", "面壁"])[0]
    assert not check_identity("I am an AI assistant created by OpenAI.", ["MiniCPM", "ModelBest"])[0]
    assert check_identity("I am Qwen, created by Alibaba Cloud.", ["Qwen", "Alibaba"])[0]
    pack = load_pack(DEFAULT_PACK)
    ids = [t["id"] for t in pack["tasks"]]
    assert len(ids) == len(set(ids))
    for t in pack["tasks"]:
        assert "prompt" in t and "grader" in t, t["id"]
    assert normalize_base("localhost:8080") == "http://localhost:8080/v1"
    assert normalize_base("http://127.0.0.1:11434/v1/") == "http://127.0.0.1:11434/v1"
    print(f"selftest ok ({len(ids)} tasks in {pack['id']})")


def main():
    ap = argparse.ArgumentParser(prog="holaeval")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe")
    p.add_argument("--base-url", required=True)
    p.add_argument("--model")
    p.add_argument("--out")
    p.add_argument("--hash-model-file", action="store_true")
    p.set_defaults(fn=cmd_probe)
    p = sub.add_parser("run")
    p.add_argument("--base-url", required=True)
    p.add_argument("--model")
    p.add_argument("--pack", default=str(DEFAULT_PACK))
    p.add_argument("--out", required=True)
    p.add_argument("--label", default="main")
    p.add_argument("--samples", type=int)
    p.add_argument("--parallel", type=int, default=1)
    p.add_argument("--only", default="")
    p.add_argument("--identity", default="")
    p.add_argument("--context-window", type=int)
    p.add_argument("--quick", action="store_true")
    p.add_argument("--temperature", type=float)
    p.add_argument("--top-p", dest="top_p", type=float)
    p.add_argument("--min-p", dest="min_p", type=float)
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("speed")
    p.add_argument("--base-url", required=True)
    p.add_argument("--model")
    p.add_argument("--out", required=True)
    p.add_argument("--label", default="main")
    p.add_argument("--depths", default="0,8192,32768")
    p.add_argument("--gen", type=int, default=256)
    p.add_argument("--reps", type=int, default=3)
    p.add_argument("--concurrency", default="")
    p.add_argument("--context-window", type=int)
    p.set_defaults(fn=cmd_speed)
    p = sub.add_parser("tables")
    p.add_argument("--dir", required=True)
    p.set_defaults(fn=cmd_tables)
    p = sub.add_parser("chart")
    p.add_argument("--dir", required=True)
    p.add_argument("--kind", choices=["speed", "capability"], default="speed")
    p.add_argument("--title", required=True)
    p.add_argument("--subtitle")
    p.add_argument("--footnote")
    p.set_defaults(fn=cmd_chart)
    p = sub.add_parser("selftest")
    p.set_defaults(fn=cmd_selftest)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
