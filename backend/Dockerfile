FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads composites

EXPOSE 3001

CMD ["node", "src/server.js"]
