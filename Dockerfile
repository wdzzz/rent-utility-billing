# syntax=docker/dockerfile:1

# 房租水电费计算 —— 运行时零第三方依赖（Node 内置 http + node:sqlite），
# 因此镜像很小，也不需要在构建时 npm install。
FROM node:24-alpine

LABEL org.opencontainers.image.title="房租水电费计算" \
      org.opencontainers.image.description="本地水电费分摊计算服务（按房间系数分摊，历史账单）" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache su-exec tzdata

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/data/billing.db \
    TZ=Asia/Shanghai

WORKDIR /app

COPY package.json ./
COPY app ./app
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /app /data

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||8787;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "app/server.js"]
