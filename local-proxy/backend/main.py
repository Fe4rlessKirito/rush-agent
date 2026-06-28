"""
FastAPI orchestrator.
  GET  /                    -> chatbox frontend
  GET  /models              -> model list for the dropdown
  GET  /bank                -> bank status (how many warm accounts ready)
  GET  /config              -> read runtime config
  POST /config              -> update runtime config
  POST /chat                -> stateful chat (we hold context), streams reply
  POST /v1/chat             -> stateless, simple OpenAI-ish
  POST /v1/chat/completions -> OpenAI-compatible (drop-in for OpenAI SDK clients)
  POST /v1/chat/with-image  -> Analyze an image (URL or base64)
  POST /v1/chat/upload-image -> Upload image file for analysis
  POST /v1/chat/with-file   -> Attach a file (PDF, docx, txt…) as context
  POST /v1/chat/upload-file -> Upload a file for analysis
  GET  /v1/models           -> List all available models
  POST /v1/messages         -> Anthropic Messages API compatibility
"""

import asyncio
import json
import logging
import re
import time
import uuid
import base64
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from worker import bank, config, health
from worker.harvester import top_up
from worker.leech import run_messages, stream_messages
from worker.direct import _upload_image_to_files, _mediatype_from_filename
from . import context
from .pool import run_guarded, run_guarded_gen

# ── Thinking level → budget_tokens map ───────────────────────────────────────
THINKING_LEVELS = {
    "low":    1024,
    "medium": 5000,
    "high":   16000,
    "max":    32000,
}

# Try to import json5 for lenient JSON parsing
try:
    import json5
    HAS_JSON5 = True
    logging.getLogger("backend").info("json5 loaded successfully")
except ImportError:
    HAS_JSON5 = False
    json5 = None
    logging.getLogger("backend").warning("json5 not installed — install it with: pip install json5")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("backend")
app = FastAPI(title="WMan")


class UTF8JSONResponse(JSONResponse):
    """JSONResponse that preserves non-ASCII characters (e.g. ×, emoji) instead of \\uXXXX escaping."""
    def render(self, content) -> bytes:
        return json.dumps(content, ensure_ascii=False).encode("utf-8")


def parse_json_lenient(raw: str) -> dict:
    """
    Parse JSON with fallback to json5 for unquoted-key tolerance.
    Clients should send valid JSON; json5 is a safety net for minor malformations.
    """
    raw = raw.strip()

    # Standard JSON — fast path for well-formed requests
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # json5 handles unquoted keys, trailing commas, single quotes, etc.
    if HAS_JSON5:
        try:
            return json5.loads(raw)
        except Exception as e:
            log.warning(f"json5 parsing failed: {e}")

    log.error(f"All JSON parsing attempts failed for body: {raw[:200]}")
    raise HTTPException(status_code=400, detail="Invalid JSON: could not parse request body")





# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Static frontend ---
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
FRONTEND_DIST = FRONTEND_DIR / "dist"
FRONTEND_INDEX = FRONTEND_DIST / "index.html"
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.on_event("startup")
async def _start_prewarmer():
    if getattr(config, "DIRECT_WS_ENABLED", False):
        from worker.account_pool import POOL
        POOL.start()
        log.info("DIRECT_WS_ENABLED -> headless path, warm account pool started")
        return

    async def loop():
        while True:
            try:
                n = await top_up()
                if n:
                    log.info("bank +%d (fresh=%d)", n, bank.count_fresh())
            except Exception as e:
                log.warning("prewarm error: %s", e)
            await asyncio.sleep(config.PREWARM_INTERVAL_SEC)
    asyncio.create_task(loop())


# --- Status endpoints ---
@app.get("/", response_class=HTMLResponse)
async def index():
    if FRONTEND_INDEX.exists():
        return FRONTEND_INDEX.read_text(encoding="utf-8")
    return """
    <!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><title>WMan frontend not built</title></head>
      <body style="font-family: system-ui; max-width: 720px; margin: 48px auto; line-height: 1.5;">
        <h1>Frontend build missing</h1>
        <p>Run these commands from <code>leech\\frontend</code>, then restart the backend:</p>
        <pre>npm install
npm run build</pre>
        <p>For live React development, run <code>npm run dev</code> and open
        <code>http://localhost:5173</code>.</p>
      </body>
    </html>
    """


@app.get("/models")
async def models():
    return {"models": config.MODELS, "default": config.DEFAULT_MODEL}


@app.get("/bank")
async def bank_status():
    if getattr(config, "DIRECT_WS_ENABLED", False):
        from worker.account_pool import POOL
        snap = health.H.snapshot(POOL.ready())
        return {
            "mode": "headless-ws",
            "warm_accounts": POOL.ready(),
            "pool_target": POOL.size,
            "status": snap["status"],
            "reasons": snap["reasons"],
        }
    snap = health.H.snapshot(bank.count_fresh())
    return {
        "fresh": snap["fresh_accounts"],
        "status": snap["status"],
        "reasons": snap["reasons"],
        "stats": bank.stats(),
    }


@app.get("/health")
async def health_status():
    if getattr(config, "DIRECT_WS_ENABLED", False):
        from worker.account_pool import POOL
        snap = health.H.snapshot(POOL.ready())
        snap["warm_accounts"] = POOL.ready()
        snap["pool_target"] = POOL.size
        return snap
    return health.H.snapshot(bank.count_fresh())


# --- Image extraction helpers (frontend) ---
MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
IMAGE_URL_RE = re.compile(
    r"(https?://[^\s<>()\"]+(?:\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s<>()\"]*)?"
    r"|/[^\s<>()\"]*(?:image|img|generated|output)[^\s<>()\"]*)"
    r"|data:image/[a-zA-Z+.-]+;base64,[a-zA-Z0-9+/=]+)",
    re.IGNORECASE,
)


def _sse_payload(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _sse(token: str) -> str:
    return _sse_payload({"type": "token", "token": token})


def _extract_image(reply: str) -> dict | None:
    markdown = MARKDOWN_IMAGE_RE.search(reply)
    if markdown:
        caption = (reply[:markdown.start()] + reply[markdown.end():]).strip()
        return {
            "url": markdown.group(2),
            "alt": markdown.group(1) or "Generated image",
            "caption": caption,
        }
    direct_url = IMAGE_URL_RE.search(reply)
    if direct_url:
        caption = (reply[:direct_url.start()] + reply[direct_url.end():]).strip()
        return {"url": direct_url.group(1), "alt": "Generated image", "caption": caption}
    return None


async def _stream_text(text: str):
    for i in range(0, len(text), 8):
        yield _sse(text[i:i + 8])
        await asyncio.sleep(0.01)
    yield "data: [DONE]\n\n"


async def _stream_reply(reply: str):
    image = _extract_image(reply)
    if not image:
        async for chunk in _stream_text(reply):
            yield chunk
        return
    caption = image.get("caption") or ""
    if caption:
        for i in range(0, len(caption), 8):
            yield _sse(caption[i:i + 8])
            await asyncio.sleep(0.01)
    yield _sse_payload({"type": "image", "image": image})
    yield "data: [DONE]\n\n"


@app.post("/chat")
async def chat(req: Request):
    raw_body = await req.body()
    body_str = raw_body.decode('utf-8')
    body = parse_json_lenient(body_str)
    message = body.get("message", "")
    model = body.get("model", "default")
    session_id = body.get("sessionId") or str(uuid.uuid4())

    messages = context.build_messages(session_id, message)
    context.append(session_id, "user", message)

    async def gen():
        parts = []
        try:
            async for delta in run_guarded_gen(lambda: stream_messages(model, messages)):
                parts.append(delta)
                yield _sse(delta)
        except Exception as exc:
            log.warning("chat stream failed: %s", exc)
            if not parts:
                yield _sse(f"Backend error ({type(exc).__name__}).")
        reply = "".join(parts).strip()
        context.append(session_id, "assistant", reply)
        image = _extract_image(reply)
        if image:
            yield _sse_payload({"type": "image", "image": image})
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/v1/chat")
async def v1_chat(req: Request):
    raw_body = await req.body()
    body_str = raw_body.decode('utf-8')
    body = parse_json_lenient(body_str)
    model = body.get("model", "default")
    reply = await run_guarded(lambda: run_messages(model, body.get("messages", [])))
    return JSONResponse({
        "model": model,
        "choices": [{"message": {"role": "assistant", "content": reply}}],
    })


def _openai_block(reply: str, model: str) -> dict:
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:24],
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": reply},
            "finish_reason": "stop",
        }],
    }


TAG_GUARD = 20  # chars to hold back while streaming to guard against split tags


def _inject_thinking_prompt(msgs: list, budget: int = 1024) -> list:
    """Prepend (or extend) a system message with the thinking prompt."""
    level = next((k for k, v in THINKING_LEVELS.items() if v == budget), None)
    depth = {
        "low":    "briefly",
        "medium": "step by step",
        "high":   "thoroughly, exploring multiple angles",
        "max":    "exhaustively, considering all possible angles and edge cases",
    }.get(level, "step by step")
    prompt = (
        f"Before you answer, reason {depth}. "
        "Format your response exactly as:\n\n"
        "<thinking>\nYour reasoning here.\n</thinking>\n\n"
        "<response>\nYour final answer here.\n</response>"
    )
    msgs = list(msgs)
    if msgs and msgs[0].get("role") == "system":
        msgs[0] = {**msgs[0], "content": msgs[0]["content"] + "\n\n" + prompt}
    else:
        msgs.insert(0, {"role": "system", "content": prompt})
    return msgs


def _parse_thinking(reply: str) -> tuple[str | None, str]:
    """Return (thinking_text, response_text) from a <thinking>/<response> tagged reply."""
    thinking_match = re.search(r'<thinking>(.*?)</thinking>', reply, re.DOTALL)
    response_match = re.search(r'<response>(.*?)</response>', reply, re.DOTALL)
    thinking = thinking_match.group(1).strip() if thinking_match else None
    response = response_match.group(1).strip() if response_match else reply.strip()
    return thinking, response


async def _stream_thinking_aware(model: str, msgs: list):
    """
    Tag-aware SSE generator that yields OpenAI chunk dicts.
    Streams thinking as content with a 'thinking' role marker in the chunk metadata,
    then streams the response as normal content chunks.
    """
    buffer = ""
    mode = "unknown"

    async for delta in run_guarded_gen(lambda: stream_messages(model, msgs)):
        buffer += delta
        while True:
            if mode == "unknown":
                if "<thinking>" in buffer:
                    buffer = buffer.split("<thinking>", 1)[1]
                    mode = "thinking"
                elif "<response>" in buffer:
                    buffer = buffer.split("<response>", 1)[1]
                    mode = "response"
                else:
                    break
            elif mode == "thinking":
                if "</thinking>" in buffer:
                    out, buffer = buffer.split("</thinking>", 1)
                    if out:
                        yield {"thinking": True, "content": out}
                    mode = "unknown"
                else:
                    safe = buffer[:-TAG_GUARD]
                    if safe:
                        yield {"thinking": True, "content": safe}
                        buffer = buffer[-TAG_GUARD:]
                    break
            elif mode == "response":
                if "</response>" in buffer:
                    out, buffer = buffer.split("</response>", 1)
                    if out:
                        yield {"thinking": False, "content": out}
                    mode = "unknown"
                else:
                    safe = buffer[:-TAG_GUARD]
                    if safe:
                        yield {"thinking": False, "content": safe}
                        buffer = buffer[-TAG_GUARD:]
                    break

    if buffer.strip():
        yield {"thinking": mode == "thinking", "content": buffer}


@app.post("/v1/chat/completions")
async def openai_completions(req: Request):
    raw_body = await req.body()
    body_str = raw_body.decode('utf-8')
    body = parse_json_lenient(body_str)
    model = body.get("model", "default")
    stream = bool(body.get("stream", False))
    msgs = body.get("messages", [])
    thinking = body.get("thinking", False)

    # Normalise: bool, object form, or named level string
    if isinstance(thinking, str):
        thinking = thinking.lower()
        budget = THINKING_LEVELS.get(thinking, THINKING_LEVELS["low"])
        thinking = True
    elif isinstance(thinking, dict):
        budget = thinking.get("budget_tokens", THINKING_LEVELS["low"])
        thinking = thinking.get("type") == "enabled"
    else:
        budget = THINKING_LEVELS["low"]
        thinking = bool(thinking)

    if thinking:
        msgs = _inject_thinking_prompt(msgs, budget)
        log.info(f"Thinking enabled on /v1/chat/completions (budget={budget}), system prompt injected")

    if stream:
        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        created = int(time.time())

        async def gen():
            base = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model}

            if not thinking:
                async for delta in run_guarded_gen(lambda: stream_messages(model, msgs)):
                    chunk = {**base, "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}]}
                    yield f"data: {json.dumps(chunk)}\n\n"
            else:
                async for part in _stream_thinking_aware(model, msgs):
                    # Carry thinking flag in a non-standard field so clients can distinguish
                    delta_obj = {"content": part["content"]}
                    if part["thinking"]:
                        delta_obj["thinking"] = True
                    chunk = {**base, "choices": [{"index": 0, "delta": delta_obj, "finish_reason": None}]}
                    yield f"data: {json.dumps(chunk)}\n\n"

            done = {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            yield f"data: {json.dumps(done)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    # Non-streaming
    reply = await run_guarded(lambda: run_messages(model, msgs))
    if thinking:
        thinking_text, response_text = _parse_thinking(reply)
        block = _openai_block(response_text, model)
        if thinking_text is not None:
            block["thinking"] = thinking_text
        return UTF8JSONResponse(block)

    return UTF8JSONResponse(_openai_block(reply, model))


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": m["slug"],
                "object": "model",
                "created": 1700000000,
                "owned_by": "leech",
                "permission": [],
                "root": m["slug"],
                "parent": None,
            }
            for m in config.MODELS
        ]
    }


# --- Image Analysis ---
@app.post("/v1/chat/with-image")
async def chat_with_image(req: Request):
    raw_body = await req.body()
    body_str = raw_body.decode('utf-8')
    body = parse_json_lenient(body_str)
    model = body.get("model", "default")
    image = body.get("image")
    question = body.get("question", "What's in this image?")
    stream = body.get("stream", False)

    if not image:
        raise HTTPException(status_code=400, detail="Image required")

    messages = [{"role": "user", "content": {"image": image, "text": question}}]

    if stream:
        async def gen():
            async for delta in stream_messages(model, messages):
                yield f"data: {json.dumps({'delta': delta})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    reply = await run_guarded(lambda: run_messages(model, messages))
    return JSONResponse({
        "model": model,
        "choices": [{"message": {"role": "assistant", "content": reply}}],
    })


@app.post("/v1/chat/upload-image")
async def upload_image(
    file: UploadFile = File(...),
    question: str = Form("What's in this image?"),
    model: str = Form("default")
):
    if file.content_type not in getattr(config, "SUPPORTED_IMAGE_FORMATS", ["image/png", "image/jpeg"]):
        raise HTTPException(400, f"Unsupported format. Supported: {getattr(config, 'SUPPORTED_IMAGE_FORMATS', [])}")
    contents = await file.read()
    max_size = getattr(config, "MAX_IMAGE_SIZE", 10 * 1024 * 1024)
    if len(contents) > max_size:
        raise HTTPException(400, f"Image too large. Max: {max_size//(1024*1024)}MB")
    b64 = base64.b64encode(contents).decode('utf-8')
    image_data = f"data:{file.content_type};base64,{b64}"
    messages = [{"role": "user", "content": {"image": image_data, "text": question}}]
    reply = await run_guarded(lambda: run_messages(model, messages))
    return {"model": model, "question": question, "analysis": reply}


@app.post("/v1/chat/with-file")
async def chat_with_file(req: Request):
    """
    Attach a file by URL to the conversation.
    The file must already be hosted (e.g. previously uploaded to files.use.ai).
    """
    raw_body = await req.body()
    body = parse_json_lenient(raw_body.decode('utf-8'))
    model = body.get("model", "default")
    file_url = body.get("file_url")
    filename = body.get("filename", "file")
    question = body.get("question", "Please analyse this file.")
    stream = body.get("stream", False)

    if not file_url:
        raise HTTPException(400, "file_url required")

    messages = [{
        "role": "user",
        "content": {"file_url": file_url, "filename": filename, "text": question}
    }]

    if stream:
        async def gen():
            async for delta in stream_messages(model, messages):
                yield f"data: {json.dumps({'delta': delta})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    reply = await run_guarded(lambda: run_messages(model, messages))
    return UTF8JSONResponse({"model": model, "filename": filename, "analysis": reply})


@app.post("/v1/chat/upload-file")
async def upload_file(
    file: UploadFile = File(...),
    question: str = Form("Please analyse this file."),
    model: str = Form("default")
):
    """
    Upload a file (PDF, docx, txt, csv…), send it to use.ai, and return the analysis.
    The file is uploaded to files.use.ai and referenced by URL in the WS frame.
    """
    MAX_FILE_SIZE = 25 * 1024 * 1024  # 25MB
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large. Max 25MB.")

    filename = file.filename or "upload"
    b64 = base64.b64encode(contents).decode('utf-8')
    media_type = file.content_type or _mediatype_from_filename(filename)

    # Upload to files.use.ai
    try:
        file_url = await _upload_image_to_files(
            f"data:{media_type};base64,{b64}", filename=filename
        )
    except Exception as e:
        raise HTTPException(502, f"File upload to use.ai failed: {e}")

    messages = [{
        "role": "user",
        "content": {"file_url": file_url, "filename": filename, "text": question}
    }]

    reply = await run_guarded(lambda: run_messages(model, messages))
    return UTF8JSONResponse({"model": model, "filename": filename, "file_url": file_url, "analysis": reply})


# ============================================================================
# ANTHROPIC MESSAGES API WITH THINKING SUPPORT
# ============================================================================
@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    """
    Anthropic Messages API compatibility endpoint.
    Converts Anthropic format to OpenAI format and back.
    This allows Claude Code to work with your leech API.
    
    NEW: Supports "thinking": true to force step-by-step reasoning.
    """
    raw_body = await request.body()
    body_str = raw_body.decode('utf-8')
    log.info(f"Raw Anthropic request: {body_str[:500]}")
    body = parse_json_lenient(body_str)

    # Extract Anthropic format
    model = body.get("model", "claude-opus-4-8")
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    system = body.get("system", "")
    max_tokens = body.get("max_tokens", 4096)
    thinking = body.get("thinking", False)

    # Normalise: bool, object form {"type":"enabled",...}, or named level string
    if isinstance(thinking, str):
        thinking = thinking.lower()
        budget = THINKING_LEVELS.get(thinking, THINKING_LEVELS["low"])
        thinking = True
    elif isinstance(thinking, dict):
        budget = thinking.get("budget_tokens", THINKING_LEVELS["low"])
        thinking = thinking.get("type") == "enabled"
    else:
        budget = THINKING_LEVELS["low"]
        thinking = bool(thinking)

    # Log the system prompt (for debugging)
    if system:
        log.info(f"System prompt received - length: {len(system)} characters")

    # Convert to OpenAI format, optionally injecting thinking system prompt
    openai_messages = []
    if system:
        openai_messages.append({"role": "system", "content": system})

    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if isinstance(content, list):
            text_parts = [p["text"] for p in content if p.get("type") == "text"]
            text = " ".join(text_parts)
        else:
            text = content
        openai_messages.append({"role": role, "content": text})

    if thinking:
        openai_messages = _inject_thinking_prompt(openai_messages, budget)
        log.info(f"Thinking enabled on /v1/messages (budget={budget}), system prompt injected")

    # --- Non‑streaming response ---
    if not stream:
        reply = await run_guarded(lambda: run_messages(model, openai_messages))
        thinking_text, response_text = _parse_thinking(reply) if thinking else (None, reply.strip())

        resp = {
            "id": f"msg_{uuid.uuid4().hex[:24]}",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": response_text}],
            "model": model,
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": 0,
                "output_tokens": len(response_text) // 4
            }
        }
        if thinking and thinking_text is not None:
            resp["thinking"] = thinking_text

        return UTF8JSONResponse(resp, headers={"Content-Type": "application/json; charset=utf-8"})

    # --- Streaming response with thinking ---
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"

    async def generate():
        log.info(f"Starting Anthropic stream for model={model} (thinking={thinking})")

        yield f"data: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'content': [], 'model': model, 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 0, 'output_tokens': 0}}})}\n\n"
        yield f"data: {json.dumps({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})}\n\n"

        delta_count = 0

        if not thinking:
            async for delta in stream_messages(model, openai_messages):
                delta_count += 1
                log.info(f"Anthropic delta #{delta_count}: {delta[:40]!r}")
                yield f"data: {json.dumps({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': delta}})}\n\n"
        else:
            thinking_done = False
            async for part in _stream_thinking_aware(model, openai_messages):
                delta_count += 1
                if part["thinking"]:
                    yield f"data: {json.dumps({'type': 'thinking_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': part['content']}})}\n\n"
                else:
                    if not thinking_done:
                        yield f"data: {json.dumps({'type': 'thinking_block_stop', 'index': 0})}\n\n"
                        thinking_done = True
                    yield f"data: {json.dumps({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': part['content']}})}\n\n"

        yield f"data: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n"
        yield f"data: {json.dumps({'type': 'message_stop'})}\n\n"
        yield "data: [DONE]\n\n"

        log.info(f"Anthropic stream complete: {delta_count} deltas sent")

    return StreamingResponse(generate(), media_type="text/event-stream")


# ── Runtime config endpoints ──────────────────────────────────────────────────
_RUNTIME_KEYS = {
    "pool_size":        ("RUNTIME_POOL_SIZE",       int),
    "signup_delay_ms":  ("RUNTIME_SIGNUP_DELAY_MS", int),
    "account_ttl_sec":  ("RUNTIME_ACCOUNT_TTL_SEC", int),
}


@app.get("/config")
async def get_config():
    """Read current runtime config values."""
    return UTF8JSONResponse({
        "pool_size":       getattr(config, "RUNTIME_POOL_SIZE",       30),
        "signup_delay_ms": getattr(config, "RUNTIME_SIGNUP_DELAY_MS", 0),
        "account_ttl_sec": getattr(config, "RUNTIME_ACCOUNT_TTL_SEC", 1800),
    })


@app.post("/config")
async def set_config(req: Request):
    """
    Update runtime config values. Changes are written to config.py on disk
    so they survive restarts.

    Body (all fields optional):
      { "pool_size": 30, "signup_delay_ms": 500, "account_ttl_sec": 3600 }
    """
    body = parse_json_lenient((await req.body()).decode("utf-8"))
    if not body:
        raise HTTPException(400, "Empty body")

    config_path = Path(__file__).parent.parent / "worker" / "config.py"
    if not config_path.exists():
        raise HTTPException(500, f"config.py not found at {config_path}")

    source = config_path.read_text(encoding="utf-8")
    updated = {}

    for field, (attr, cast) in _RUNTIME_KEYS.items():
        if field not in body:
            continue
        try:
            value = cast(body[field])
        except (ValueError, TypeError):
            raise HTTPException(400, f"Invalid value for {field}: must be {cast.__name__}")

        # Replace the line in config.py: ATTR = <old_value>
        pattern = re.compile(rf"^({re.escape(attr)}\s*=\s*)(.+)$", re.MULTILINE)
        if not pattern.search(source):
            raise HTTPException(500, f"{attr} not found in config.py")
        source = pattern.sub(rf"\g<1>{value}", source)

        # Apply to live module
        setattr(config, attr, value)
        updated[field] = value

        # Propagate to pool/account config where needed
        if attr == "RUNTIME_POOL_SIZE":
            config.ACCOUNT_POOL_SIZE = value
        elif attr == "RUNTIME_ACCOUNT_TTL_SEC":
            config.ACCOUNT_TTL_SEC = value

    if not updated:
        raise HTTPException(400, f"No valid fields. Valid: {list(_RUNTIME_KEYS)}")

    config_path.write_text(source, encoding="utf-8")
    log.info(f"Runtime config updated: {updated}")
    return UTF8JSONResponse({"updated": updated, "status": "ok"})
@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "HEAD"])
async def catch_all_v1(path: str, request: Request):
    """Catch all /v1/* requests and handle path duplication from Claude Code."""
    if path.startswith("v1/"):
        new_path = path[3:]  # Remove "v1/"
        log.info(f"Rewriting path: /v1/{path} -> /{new_path}")
    else:
        new_path = path
    
    if new_path == "messages":
        return await anthropic_messages(request)
    elif new_path == "models":
        return await list_models()
    elif new_path == "chat/completions":
        return await openai_completions(request)
    else:
        return JSONResponse({"error": "Not found", "path": path}, status_code=404)


@app.head("/v1")
async def v1_head():
    return JSONResponse({})


@app.get("/v1")
async def v1_get():
    return JSONResponse({
        "version": "1.0",
        "provider": "leech",
        "endpoints": [
            "/v1/messages",
            "/v1/chat/completions",
            "/v1/models",
            "/v1/chat/with-image",
            "/v1/chat/upload-image",
            "/v1/chat/with-file",
            "/v1/chat/upload-file",
        ]
    })