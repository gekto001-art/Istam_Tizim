FROM postgres:16-alpine
RUN apk add --no-cache aws-cli curl openssl tzdata
ENV TZ=Asia/Tashkent
COPY scripts /scripts
RUN chmod +x /scripts/*.sh
VOLUME /backups
ENTRYPOINT ["/scripts/entrypoint.sh"]
