FROM n8nio/n8n:latest

USER root

ENV N8N_PORT=5678
ENV N8N_PROTOCOL=http
ENV NODE_ENV=production
ENV N8N_HOST=0.0.0.0
ENV WEBHOOK_URL=${RAILWAY_STATIC_URL}
ENV N8N_USER_FOLDER=/home/node/.n8n

RUN mkdir -p /home/node/.n8n && chmod -R 777 /home/node/.n8n

EXPOSE 5678

CMD ["n8n", "start"]
