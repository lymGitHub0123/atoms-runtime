FROM docker.m.daocloud.io/library/node:22-bookworm-slim

# 不装 apt 包，保证在国内网络下构建稳定；git 等工具按需再补
RUN npm config set registry https://registry.npmmirror.com \
  && npm i -g pnpm@9.12.0

RUN useradd -m -u 10001 agent \
  && mkdir -p /workspace \
  && chown -R agent:agent /workspace

COPY static-server.mjs /opt/static-server.mjs

WORKDIR /workspace
USER agent

CMD ["sleep", "infinity"]