FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package manifests first for better caching
COPY package.json package-lock.json* ./

# Install only production deps by default
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
RUN npm ci --omit=dev

# Copy app files
COPY . .

# Expose port
EXPOSE 3000

# Create storage dir
RUN mkdir -p /usr/src/app/storage

# Start
CMD ["node", "src/server.js"]
