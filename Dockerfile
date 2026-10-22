FROM oven/bun:1.4.3 AS base

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl bzip2 ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV LD_LIBRARY_PATH=/app/node_modules/sherpa-onnx-linux-x64:/app/node_modules/sherpa-onnx-linux-arm64
ENV TWBIT_MODEL_DIR=/models/gigaam-v3

FROM base AS tone-reference
ARG TONE_MODEL_VERSION=2025-09-08
RUN mkdir -p /models/t-one \
    && curl --fail --location --retry 3 \
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-t-one-russian-${TONE_MODEL_VERSION}.tar.bz2" \
        --output /tmp/t-one.tar.bz2 \
    && tar -xjf /tmp/t-one.tar.bz2 --strip-components=1 -C /models/t-one \
    && rm /tmp/t-one.tar.bz2

FROM base AS model
ARG GIGAAM_MODEL_VERSION=2025-12-16
RUN mkdir -p /models/gigaam-v3 \
    && curl --fail --location --retry 3 \
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-${GIGAAM_MODEL_VERSION}.tar.bz2" \
        --output /tmp/gigaam.tar.bz2 \
    && tar -xjf /tmp/gigaam.tar.bz2 --strip-components=1 -C /models/gigaam-v3 \
    && curl --fail --location --retry 3 \
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad_v5.onnx" \
        --output /models/gigaam-v3/silero_vad.onnx \
    && rm /tmp/gigaam.tar.bz2

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS tested-app
COPY --from=model /models /models
COPY index.ts tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY migrations ./migrations
COPY web ./web
RUN --network=none bun run typecheck && bun test && bun run build:web
RUN mkdir -p /data && chown bun:bun /data

FROM tested-app AS benchmark
COPY --from=tone-reference /models/t-one /models/t-one
USER bun
ENTRYPOINT ["bun", "run", "scripts/benchmark-speech.ts"]

FROM tested-app AS app
USER bun
EXPOSE 3000
ENTRYPOINT ["bun", "run", "index.ts"]
