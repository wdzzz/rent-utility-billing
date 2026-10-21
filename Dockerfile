# 房租水电费计算 —— 运行时零第三方依赖（Node 内置 http + node:sqlite），
# 因此镜像很小，也不需要在构建时 npm install。
# 基础镜像默认用官方 node:24-alpine；网络受限时可用 --build-arg BASE_IMAGE=镜像源/library/node:24-alpine 指定镜像站
ARG BASE_IMAGE=node:24-alpine
FROM ${BASE_IMAGE}

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

# 宿主机文件权限可能是 711/600，统一补上可读/可执行，避免容器以非 root 运行时打不开
RUN chmod 755 /usr/local/bin/entrypoint.sh \
 && chmod -R a+rX /app \
 && mkdir -p /data \
 && chown -R node:node /app /data

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||8787;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "app/server.js"]
