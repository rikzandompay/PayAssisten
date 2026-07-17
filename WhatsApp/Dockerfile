FROM alimustopaaop/wa-web-api:v1

RUN npm install whatsapp-web.js@latest

COPY whatsapp-patched.js /app/src/services/whatsapp.js
EXPOSE 3000
