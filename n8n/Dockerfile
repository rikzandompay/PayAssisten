FROM n8nio/n8n:latest

USER root

ENV N8N_PORT=5678
ENV N8N_PROTOCOL=http
ENV NODE_ENV=production
ENV N8N_HOST=0.0.0.0
ENV WEBHOOK_URL=${RAILWAY_STATIC_URL}
ENV N8N_USER_FOLDER=/data/n8n

RUN mkdir -p /data/n8n && chmod -R 777 /data && \
    echo '#!/bin/sh' > /entrypoint.sh && \
    echo 'mkdir -p /data/n8n && chmod -R 777 /data/n8n' >> /entrypoint.sh && \
    echo 'exec n8n start' >> /entrypoint.sh && \
    chmod +x /entrypoint.sh

EXPOSE 5678

ENTRYPOINT ["/entrypoint.sh"]
