import logging
from fastapi import APIRouter, Request, HTTPException
from urllib.parse import quote, urlencode

log = logging.getLogger("backend.image_gen")
router = APIRouter(prefix="/api", tags=["generation"])

# Using Pollinations AI as a reliable, free text-to-image provider
POLLINATIONS_BASE_URL = "https://image.pollinations.ai/prompt/"

def _bounded_int(value, default: int, lo: int, hi: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, parsed))


def _clean_model(value) -> str:
    model = str(value or "flux").strip()
    return model if model.replace("-", "").replace("_", "").isalnum() else "flux"

@router.get("/generate-image")
@router.post("/generate-image")
async def generate_image(request: Request):
    """
    Generates an image from a prompt.
    Accepts 'prompt', 'width', 'height', 'model', and 'seed' as parameters.
    """
    if request.method == "POST":
        try:
            body = await request.json()
            prompt = body.get("prompt")
            width = body.get("width", 1024)
            height = body.get("height", 1024)
            model = body.get("model", "flux")
            seed = body.get("seed")
        except Exception:
            prompt = None
    else:
        prompt = request.query_params.get("prompt")
        width = request.query_params.get("width", 1024)
        height = request.query_params.get("height", 1024)
        model = request.query_params.get("model", "flux")
        seed = request.query_params.get("seed")

    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    width = _bounded_int(width, 1024, 64, 2048)
    height = _bounded_int(height, 1024, 64, 2048)
    model = _clean_model(model)

    params = {
        "width": width,
        "height": height,
        "model": model,
        "nologo": "true",
    }
    if seed:
        params["seed"] = _bounded_int(seed, 0, 0, 2_147_483_647)
    url = f"{POLLINATIONS_BASE_URL}{quote(prompt, safe='')}?{urlencode(params)}"

    # Since the request is just a redirect to the generated asset or a URL return,
    # we return a structured JSON response that the frontend can render.
    return {
        "status": "success",
        "prompt": prompt,
        "image_url": url,
        "model": model,
        "dimensions": f"{width}x{height}"
    }
