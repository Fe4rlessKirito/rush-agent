import asyncio
import json
import logging
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse

log = logging.getLogger("backend.image_gen")
router = APIRouter(prefix="/api", tags=["generation"])

# Using Pollinations AI as a reliable, free text-to-image provider
POLLINATIONS_BASE_URL = "https://image.pollinations.ai/prompt/"

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
        except:
            prompt = None
    else:
        prompt = request.query_params.get("prompt")
        width = request.query_params.get("width", 1024)
        height = request.query_params.get("height", 1024)
        model = request.query_params.get("model", "flux")
        seed = request.query_params.get("seed")

    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    # Construct Pollinations URL
    # Format: https://image.pollinations.ai/prompt/{prompt}?width={w}&height={h}&model={m}&seed={s}&nologo=true
    safe_prompt = prompt.replace(" ", "%20").replace("/", " ")
    url = f"{POLLINATIONS_BASE_URL}{safe_prompt}?width={width}&height={height}&model={model}&nologo=true"
    
    if seed:
        url += f"&seed={seed}"

    # Since the request is just a redirect to the generated asset or a URL return,
    # we return a structured JSON response that the frontend can render.
    return {
        "status": "success",
        "prompt": prompt,
        "image_url": url,
        "model": model,
        "dimensions": f"{width}x{height}"
    }
