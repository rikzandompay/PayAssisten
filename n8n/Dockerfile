FROM n8nio/n8n:latest

USER root

ENV N8N_PORT=5678
ENV N8N_PROTOCOL=http
ENV NODE_ENV=production
ENV N8N_HOST=0.0.0.0
ENV WEBHOOK_URL=${RAILWAY_STATIC_URL}
ENV N8N_USER_FOLDER=/data/n8n

# Copy workflow file into container
COPY wa-bot-workflow-fixed.json /app/workflow.json

RUN mkdir -p /data/n8n && chmod -R 777 /data

# Create entrypoint that auto-imports workflow then starts n8n
COPY n8n-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5678

ENTRYPOINT ["/entrypoint.sh"]
