⚡ Performance Improvements
4× faster – request handling is snappier, especially under load.

5× less memory – idle memory dropped from ~15 MB to ~3 MB. (only around 2mb at startup ram usage will grow depending on how many accounts are in pool) this is without counting the tor proxies

10× faster WebSocket frame processing – each chunk is processed in ~0.5 ms instead of ~5 ms.

Concurrency – handles 100+ concurrent streams easily (vs. 24 with Python).

Startup – from ~2 seconds to ~0.1 seconds.

Single binary – no Python, no virtual environment, no Playwright. Just one executable (~15 MB).

🔥 New Features
Dynamic Tor scaling – the proxy monitors incoming request load and pool fullness. It automatically spawns new Tor instances when traffic spikes, and kills them when things quiet down. No more manual tor_ports lists – it adapts in real time.

Auto‑launches Tor –  The proxy starts it, handles the SOCKS port, and even kills it on shutdown.

Load monitoring – new /proxies endpoint shows active proxies, request rate, and windowed request count. Great for observability.

Better error handling – automatic retries on 429 (rate limit) with exponential backoff, plus fallback to direct mode if all proxies fail.
