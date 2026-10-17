# Offline demo: a private HTTP tracker plus an aria2 seeder for a generated file.
FROM node:22-alpine
RUN apk add --no-cache aria2 mktorrent \
 && npm install -g --no-audit --no-fund bittorrent-tracker@11.2.3
COPY --chmod=755 start.sh /usr/local/bin/start.sh
EXPOSE 8000 6881
CMD ["/usr/local/bin/start.sh"]
