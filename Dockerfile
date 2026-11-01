FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs package.json ./
ENV NODE_ENV=production
EXPOSE 10000
# atualiza o yt-dlp toda vez que o servidor liga (o YouTube muda direto)
CMD ["sh", "-c", "pip3 install -q -U --break-system-packages 'yt-dlp[default]' >/dev/null 2>&1; exec node server.mjs"]
