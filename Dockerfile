# =========================================================================
# Stage 1: The "Builder" - Compile a secure `gosu` binary from source
# =========================================================================
# Use the official Go image based on Debian Bookworm to perfectly match our final image's OS.
FROM golang:1.24-alpine AS builder

# Install git, which is needed to clone the gosu source code.
RUN apk add --no-cache git

# Set the version of gosu we want to build. 1.17 is the latest stable version.
ENV GOSU_VERSION=1.17

# Clone the gosu repository, check out the specific version tag...
RUN git clone https://github.com/tianon/gosu.git /gosu
RUN cd /gosu && git checkout "$GOSU_VERSION"

# ...and build it as a static binary, which is self-contained.
# CGO_ENABLED=0 ensures no C libraries are linked.
# -ldflags "-s -w" strips debug symbols, making the binary smaller.
RUN cd /gosu && CGO_ENABLED=0 go build -v -ldflags="-s -w" -o /usr/local/bin/gosu .

# =========================================================================
# Stage 2: The "Final Image" - Our Node.js Application
# =========================================================================
# Use the official Node.js LTS alpine runtime as our secure and reliable base.
FROM node:22-alpine

# Copy the freshly compiled gosu binary from our builder stage.
COPY --from=builder /usr/local/bin/gosu /usr/local/bin/gosu

# Install only the remaining system dependencies.
RUN apk add --no-cache sqlite sqlite-dev python3 make g++ shadow

# Ensure the latest npm is installed to avoid upgrade notices
RUN npm install -g npm@11.4.1

#RUN apk add --no-cache sqlite sqlite-dev python3 make g++

# Set the working directory inside the container.
WORKDIR /app

# =========================================================================
# Create a generic, non-root user and group
# =========================================================================
RUN addgroup --system --gid 1001 appgroup
RUN adduser --system --uid 1001 --ingroup appgroup --shell /bin/sh appuser

# =========================================================================
# Copy and build the application
# =========================================================================
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

# =========================================================================
# Set up environment and permissions
# =========================================================================

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/healthcheck.sh
RUN chown -R appuser:appgroup /app

# Run the container as the non-root user by default
USER appuser

# Set our script as the entrypoint for the container.
ENTRYPOINT ["entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/usr/local/bin/healthcheck.sh"]

# =========================================================================
# Define the default command
# =========================================================================
CMD ["node", "dist/index.js"]
