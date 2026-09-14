# Licence server.
#
# At the repo root so hosts that build from the root - Railway, Render and most
# others by default - find it without anyone configuring a subdirectory. The
# server itself lives in server/; only those files are copied in.
#
# Nothing from the main package.json is installed. The server has no
# dependencies beyond Node, and the desktop app's 170 packages have no business
# in an image that answers "is this licence key valid".
#
# The one thing that MUST be right is storage. LICENCE_DB has to point at a
# mounted volume. Most hosts give containers an ephemeral filesystem, wiped on
# every restart and deploy - and losing that file locks out every paying
# customer at once, with no way to tell who they were. The server refuses to
# start if it detects that situation.
FROM node:22-alpine

WORKDIR /app
COPY server/package.json server/licence-server.js server/razorpay-webhook.js ./

ENV LICENCE_DB=/data/licences.json
ENV PORT=8787
VOLUME ["/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "licence-server.js"]
