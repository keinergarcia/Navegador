# syntax=docker/dockerfile:1
FROM nginx:stable-alpine

LABEL org.opencontainers.image.title="CloudDesk edge" \
      org.opencontainers.image.description="Nginx: TLS, panel estático y proxy a KasmVNC"

RUN apk add --no-cache curl \
    && rm -f /etc/nginx/conf.d/default.conf \
    && mkdir -p /var/www/certbot

COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/templates/ /etc/nginx/templates/
COPY web/ /usr/share/nginx/html/

# Valida la sintaxis de nginx.conf. La plantilla con variables se valida en CI
# con certificados de prueba (ver .github/workflows/ci.yml).
RUN nginx -t -c /etc/nginx/nginx.conf

EXPOSE 80 443
STOPSIGNAL SIGQUIT
