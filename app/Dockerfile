FROM node:22-slim

WORKDIR /app

# min-release-age（.npmrc）を使うため、対応する npm 11.10.0 以降に差し替える
RUN npm install -g npm@11.17.0

COPY package*.json .npmrc ./
RUN npm install

COPY . .

# npm install の時点では prisma/schema.prisma がまだイメージに無く generate が
# 走らないため、ここで改めて生成する。generate は DB に接続しないが、
# prisma.config.ts の読み込みに DATABASE_URL が必須（未設定だと config の
# ロード自体が失敗する）なので、値は形式が合っていれば何でもよいダミーを与える
RUN DATABASE_URL=postgres://postgres:postgres@localhost:5432/app npx prisma generate

EXPOSE 3000

CMD ["npm", "run", "dev"]
