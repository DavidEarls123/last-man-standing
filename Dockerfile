# For anywhere that takes a container — Fly.io, Railway, a VPS.
# Render uses render.yaml instead and needs none of this.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY package*.json ./
COPY web/package*.json ./web/
RUN npm install --omit=dev && npm --prefix web install

COPY . .
RUN npm --prefix web run build

# The database belongs on a mounted volume, not in the image: without one it
# is thrown away with the container on every deploy.
ENV NODE_ENV=production \
    DATABASE_FILE=/data/lms.sqlite \
    PORT=3000
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
