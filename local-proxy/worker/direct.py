"""
Headless DIRECT path: sign up a throwaway account (HTTP) and stream the reply
over use.ai's budget-agent WebSocket. No browser in the hot path.

Protocol (verified 2026-06-26):
  CONNECT wss://agents.use.ai/agents/budget-agent/<chatId>
            ?userId=<uuid>&userType=regular&userEmail=<email>&planType=free&isTestUser=false
  SEND    one JSON frame with messages containing parts:
            parts: [{"type": "file", "mediaType": "image/png", "url": "...", "filename": "..."}]
  RECV    Vercel-AI-SDK frames wrapped as {index,streamId,chunk:{...}}:
            text-delta(delta=..) tokens, terminated by finish / stream-complete.
            Cap -> {"type":"rate-limit-error",...}
"""
import asyncio
import json
import logging
import re
import uuid
import base64
import os
import tempfile
import httpx

from . import config
from .session_http import create_account

log = logging.getLogger("direct")

# Tags injected by use.ai that we strip silently from deltas.
# We whitelist our own tags (<thinking>, <response>) so they pass through.
# Pattern: any <tag ...>...</tag> or self-closing <tag .../> where tag is NOT
# one of our own. Catches <system ...>, <reminder ...>, <context ...>, etc.
_OWN_TAGS = {"thinking", "response"}
_INJECTED_TAG_RE = re.compile(
    r'<(?!(?:' + '|'.join(_OWN_TAGS) + r')(?:\s|>|/))([a-zA-Z][\w-]*)(?:[^>]*)>.*?</\1>|'
    r'<(?!(?:' + '|'.join(_OWN_TAGS) + r')(?:\s|>|/))([a-zA-Z][\w-]*)(?:[^>]*)/?>',
    re.DOTALL
)


def _strip_injected_tags(text: str) -> str:
    """Remove use.ai system/reminder/context injections silently."""
    return _INJECTED_TAG_RE.sub('', text)

try:
    import websockets
except ImportError:
    websockets = None

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36")


def enabled() -> bool:
    return bool(getattr(config, "DIRECT_WS_ENABLED", False)) and websockets is not None


def _model_slug(model: str) -> str:
    return config.resolve_model(model)


async def _upload_image_to_files(image_data: str, filename: str = "image.png") -> str:
    """
    Upload a file to use.ai's file service and return the URL.
    
    Args:
        image_data: Base64 encoded data, data URI, or URL
        filename: The filename to use for the upload
        
    Returns:
        The URL of the uploaded file on files.use.ai
    """
    # If it's already a URL, return it as-is
    if image_data.startswith(('http://', 'https://')):
        return image_data
    
    media_type = _mediatype_from_filename(filename)

    # If it's a data URI, extract the media type and base64 payload.
    if image_data.startswith('data:') and ',' in image_data:
        header, base64_data = image_data.split(',', 1)
        match = re.match(r"data:([^;,]+)(?:;base64)?$", header, re.IGNORECASE)
        if match:
            media_type = match.group(1)
    else:
        base64_data = image_data
    
    # Decode base64 to validate the payload before upload.
    try:
        base64.b64decode(base64_data, validate=True)
    except Exception as e:
        log.warning(f"Failed to decode base64 file payload: {e}")
        raise RuntimeError(f"Invalid base64 file data: {e}")
    
    # Upload to use.ai
    upload_url = "https://files.use.ai/upload"
    headers = {
        "User-Agent": _UA,
        "Origin": "https://use.ai",
        "Referer": "https://use.ai/",
    }
    
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.post(
                upload_url,
                headers=headers,
                data={"name": filename, "type": media_type},
                files={"file": (filename, base64_data.encode("utf-8"), media_type)},
            )
            response.raise_for_status()
            data = response.json()
            
            if data.get("success"):
                # Construct the full URL
                file_url = data.get("url")
                if not isinstance(file_url, str) or not file_url:
                    raise RuntimeError(f"Upload succeeded without a URL: {data}")
                if file_url.startswith("/"):
                    file_url = f"https://files.use.ai{file_url}"
                log.info(f"Uploaded file: {file_url}")
                return file_url
            else:
                raise RuntimeError(f"Upload failed: {data}")
        except Exception as e:
            log.warning(f"File upload failed: {e}")
            raise RuntimeError(f"Failed to upload file: {e}")


def _build_image_parts(image_data: str, text: str = "", filename: str = "image.png") -> list:
    """
    Build message parts with image support for use.ai WebSocket.
    use.ai expects images as 'file' type with mediaType, url, and filename.
    """
    parts = []
    
    # Add text part first
    if text:
        parts.append({"type": "text", "text": text})
    
    media_type = _mediatype_from_filename(filename)

    # The image_data should be a URL at this point, but handle both URL and
    # base64/data URI gracefully.
    if image_data.startswith(('http://', 'https://')):
        # It's a URL - use it directly
        parts.append({
            "type": "file",
            "mediaType": media_type if media_type.startswith("image/") else "image/png",
            "url": image_data,
            "filename": filename
        })
    else:
        # It's base64 data - use as a data URI
        if image_data.startswith('data:') and ',' in image_data:
            header = image_data.split(',', 1)[0]
            match = re.match(r"data:([^;,]+)(?:;base64)?$", header, re.IGNORECASE)
            if match:
                media_type = match.group(1)
        elif not image_data.startswith('data:image'):
            if not media_type.startswith("image/"):
                media_type = "image/png"
            image_data = f"data:{media_type};base64,{image_data}"
        parts.append({
            "type": "file",
            "mediaType": media_type if media_type.startswith("image/") else "image/png",
            "url": image_data,
            "filename": filename
        })
    
    return parts


def _mediatype_from_filename(filename: str) -> str:
    """Guess mediaType from filename extension."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return {
        "pdf":  "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc":  "application/msword",
        "txt":  "text/plain",
        "csv":  "text/csv",
        "png":  "image/png",
        "jpg":  "image/jpeg",
        "jpeg": "image/jpeg",
        "gif":  "image/gif",
        "webp": "image/webp",
    }.get(ext, "application/octet-stream")


def _to_parts(messages: list) -> list:
    """[{role, content}] -> use.ai message-parts. Supports images and files."""
    out = []
    for m in messages:
        content = m.get("content")
        if not content:
            continue

        role = m.get("role")
        if role not in ("user", "assistant"):
            role = "user"

        if isinstance(content, dict) and content.get("image"):
            # Image message: {"image": "base64 or URL", "text": "...", "filename": "..."}
            image_data = content.get("image")
            text = content.get("text", "What's in this image?")
            filename = content.get("filename", "image.png")
            parts = _build_image_parts(image_data, text, filename)

        elif isinstance(content, dict) and content.get("file_url"):
            # File attachment: {"file_url": "https://...", "filename": "doc.pdf", "text": "..."}
            file_url = content["file_url"]
            filename = content.get("filename", "file")
            text = content.get("text", "")
            media_type = content.get("media_type") or _mediatype_from_filename(filename)
            parts = []
            if text:
                parts.append({"type": "text", "text": text})
            parts.append({
                "type": "file",
                "mediaType": media_type,
                "url": file_url,
                "filename": filename,
            })

        elif isinstance(content, list):
            # Already in parts format
            parts = content

        else:
            # Plain text
            parts = [{"type": "text", "text": str(content)}]

        out.append({
            "id": uuid.uuid4().hex[:16],
            "role": role,
            "parts": parts,
            "metadata": {}
        })

    if not out:
        out.append({
            "id": uuid.uuid4().hex[:16],
            "role": "user",
            "parts": [{"type": "text", "text": ""}],
            "metadata": {}
        })
    return out


def _build_frame(chat_id, user_id, email, model, parts):
    return {
        "chatId": chat_id,
        "userId": user_id,
        "email": email,
        "userType": "regular",
        "userEmail": email,
        "planType": "free",
        "subscriptionStatus": "inactive",
        "isFreemium": False,
        "isTestUser": False,
        "experimentCohort": "A",
        "cfModelsVariant": "OFF",
        "mixpanelUserId": str(uuid.uuid4()),
        "deviceId": str(uuid.uuid4()),
        "isWebSearchMode": False,
        "isDeepResearchMode": False,
        "isImageGenerationMode": False,
        "agenticMode": False,
        "isStandaloneImageMode": False,
        "needsBlurPreview": False,
        "deepResearchProcessor": "pro-fast",
        "selectedModel": config.MODEL_PREFIX + _model_slug(model),
        "locale": "en",
        "userTimezone": "Europe/Zagreb",
        "userCountry": "Croatia (HR)",
        "messages": parts,
        "trigger": "submit-message",
        "source": "chat_page",
    }


async def _stream_gen(acct: dict, model: str, parts: list):
    """Yield text deltas as they arrive."""
    chat_id = str(uuid.uuid4())
    uri = (f"{config.WS_AGENT_BASE}/{chat_id}"
           f"?userId={acct['user_id']}&userType=regular"
           f"&userEmail={acct['email']}&planType=free&isTestUser=false")
    hdrs = {"Cookie": acct["cookie_header"], "Origin": "https://use.ai", "User-Agent": _UA}
    idle = getattr(config, "WS_IDLE_TIMEOUT", 90)
    
    # Build the frame
    frame = _build_frame(chat_id, acct["user_id"], acct["email"], model, parts)
    log.info(f"Sending frame with {len(parts)} message parts")
    
    async with websockets.connect(uri, additional_headers=hdrs, max_size=None,
                                  open_timeout=config.WS_OPEN_TIMEOUT,
                                  ping_interval=20, ping_timeout=60) as ws:
        await ws.send(json.dumps(frame))
        delta_count = 0
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=idle)
            except asyncio.TimeoutError:
                log.info(f"WebSocket idle timeout after {delta_count} deltas")
                break
            except websockets.ConnectionClosed:
                log.info(f"WebSocket closed after {delta_count} deltas")
                break
            try:
                o = json.loads(raw)
            except Exception:
                continue
            if o.get("type") == "rate-limit-error":
                raise RuntimeError("rate-limit-error: " +
                                   o.get("messageMetadata", {}).get("errorType", "?"))
            chunk = o.get("chunk")
            if isinstance(chunk, dict):
                t = chunk.get("type")
                if t == "text-delta":
                    d = chunk.get("delta", "")
                    if isinstance(d, bytes):
                        d = d.decode("utf-8")
                    d = _strip_injected_tags(d)
                    if d:
                        delta_count += 1
                        log.info(f"WebSocket delta #{delta_count}: {d[:40]!r}")
                        yield d
                elif t == "finish":
                    log.info(f"WebSocket finish after {delta_count} deltas")
                    break
            if o.get("type") == "stream-complete":
                log.info(f"WebSocket stream-complete after {delta_count} deltas")
                break


async def stream(model: str, prompt: str | None = None,
                 messages: list | None = None, acct: dict | None = None):
    """Async generator of text deltas."""
    if websockets is None:
        raise RuntimeError("websockets not installed")
    parts = _to_parts(messages if messages else [{"role": "user", "content": prompt or ""}])
    last = None
    for attempt in range(1, config.DIRECT_WS_RETRIES + 1):
        a = acct or await create_account()
        acct = None
        produced = False
        try:
            async for d in _stream_gen(a, model, parts):
                produced = True
                yield d
            if produced:
                return
            last = RuntimeError("empty reply")
        except Exception as e:
            last = e
            if produced:
                log.warning("direct stream broke mid-reply (%r) -> ending with partial", e)
                return
            log.warning("direct attempt %d/%d failed: %r",
                        attempt, config.DIRECT_WS_RETRIES, e)
    if last:
        raise last


async def complete(model: str, prompt: str | None = None,
                   messages: list | None = None, acct: dict | None = None) -> str:
    """Buffered variant: collect the whole reply."""
    out = []
    async for d in stream(model, prompt=prompt, messages=messages, acct=acct):
        out.append(d)
    reply = "".join(out).strip()
    if not reply:
        raise RuntimeError("empty reply")
    return reply
