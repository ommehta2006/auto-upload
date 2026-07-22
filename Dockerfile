FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISPLAY=:99

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb x11vnc openbox novnc websockify ffmpeg ca-certificates curl tini x11-utils unzip \
    && curl -fsSL -o /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/google-chrome-stable_current_amd64.deb \
    && rm -f /tmp/google-chrome-stable_current_amd64.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN chmod +x /app/deploy/entrypoint.sh \
    && mkdir -p /app/storage /app/tmp \
    && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 3000 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
