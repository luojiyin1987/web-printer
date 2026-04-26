FROM node:20-slim

LABEL maintainer="web-printer"

# Install LibreOffice headless and common fonts for PDF conversion.
# Using --no-install-recommends keeps the image smaller.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    fonts-liberation \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Verify LibreOffice is available
RUN soffice --version

WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Ensure tmp directories exist
RUN mkdir -p tmp-uploads tmp-previews

# Create a non-root user for security
RUN groupadd -r printer && useradd -r -g printer printer \
    && chown -R printer:printer /app
USER printer

EXPOSE 3000

# Health check against the config endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/config', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "start"]
