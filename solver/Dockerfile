FROM node:22-slim
WORKDIR /app
COPY package.json server.js monday.js integrations.js security.js sheets.js ext.js automation.js ai.js docs.js push.js alerts.js comms.js email.js blast.js gmail.js apps.js newleads.js sequences.js crossboard.js stats.js features.js ./
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
