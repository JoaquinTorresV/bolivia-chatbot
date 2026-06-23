FROM node:22-alpine

# dependencias necesarias para compilar better-sqlite3 en alpine
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# crear directorio persistente para la BD
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/index.js"]
