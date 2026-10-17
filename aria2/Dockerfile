FROM alpine:3.22

RUN apk add --no-cache aria2=~1.37 ca-certificates \
 && addgroup -g 1000 aria2 && adduser -D -u 1000 -G aria2 aria2 \
 && mkdir -p /downloads && chown aria2:aria2 /downloads

COPY aria2.conf /etc/aria2/aria2.conf
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

USER aria2
EXPOSE 6800 51413 51413/udp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
