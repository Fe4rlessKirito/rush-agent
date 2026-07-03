FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/tsconfig.json ./
COPY frontend/src ./src
RUN npm run build && cp src/index.html dist/index.html

FROM rust:1.89-bookworm AS rust-builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY config.toml ./config.toml
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tor \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=rust-builder /app/target/release/leech-rs /app/leech-rs
COPY --from=rust-builder /app/config.toml /app/config.toml
COPY --from=rust-builder /app/frontend/dist /app/frontend/dist

RUN mkdir -p /data/usage /data/tor

ENV LEECH__SERVER__HOST=0.0.0.0
ENV LEECH__SERVER__PORT=8080
ENV LEECH_DATA_DIR=/data/usage
ENV LEECH_TOR_DATA_ROOT=/data/tor
ENV TOR_BIN=/usr/bin/tor

EXPOSE 8080

CMD ["/app/leech-rs"]
