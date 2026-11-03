FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

COPY package.json ./
COPY README.md index.html styles.css ./
COPY app.js local-simulator.js kraken-bot.js kraken-ui.js ./
COPY server.js bot-service.js ./

EXPOSE 8080
CMD ["node", "server.js"]
