FROM alimustopaaop/wa-web-api:v1

RUN npm install whatsapp-web.js@latest

COPY whatsapp-patched.js /app/src/services/whatsapp.js
COPY docker-entrypoint-custom.sh /app/docker-entrypoint-custom.sh
RUN chmod +x /app/docker-entrypoint-custom.sh

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint-custom.sh"]
