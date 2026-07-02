FROM node:18-bullseye-slim

# Install system dependencies for canvas, Python, and TensorFlow
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
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Create scripts directory
RUN mkdir -p scripts

# Copy download script before installing
COPY scripts/download-models.js scripts/

# Copy package files
COPY package*.json ./

# Install dependencies (postinstall will run download-models.js)
RUN npm install --production=false

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the app
CMD ["node", "server.js"]
