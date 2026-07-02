FROM node:18-bullseye-slim

# Install system dependencies for canvas and Python
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production=false

# Copy app source
COPY . .

# Download face models
RUN npm run postinstall

# Expose port
EXPOSE 3000

# Start the app
CMD ["node", "server.js"]
